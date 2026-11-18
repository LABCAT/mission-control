import { ValidationError, type CollectionConfig, type CompoundIndex, type Field, type Validate } from 'payload'

import { tenantContentWriteAccess } from '../access'

export const LOCATION_KINDS = ['region', 'island', 'town'] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]

export const locationKindOptions = LOCATION_KINDS.map((value) => ({
  label: value === 'region' ? 'Region' : value === 'island' ? 'Island' : 'Town',
  value,
}))

/**
 * Allowed parent kinds per kind. A parent is always broader than its child — a `region` is a
 * root, an `island` hangs off a region, a `town` off a region or island — so a parent cycle
 * cannot be built and no cycle walk is needed.
 */
export const ALLOWED_PARENT_KINDS: Record<LocationKind, readonly LocationKind[]> = {
  island: ['region'],
  region: [],
  town: ['region', 'island'],
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Lowercase ASCII slug: `Anywhere/Work From Home` becomes `anywhere-work-from-home`. */
export const slugifyLocationName = (name: string): string =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

type LocationRef = number | string | { id: number | string } | null | undefined

type LocationData = {
  id?: number | string
  kind?: LocationKind | null
  parent?: LocationRef
  slug?: null | string
  tenant?: LocationRef
}

const idOf = (value: LocationRef): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value.id ?? null

  return value
}

export type LocationsOptions = {
  /**
   * In multi-tenant mode every location must name a tenant. The tenant is what scopes the
   * slug and the parent comparison, so a tenantless row would sit outside the tenant tree
   * (and its parent could belong to any tenant). Single-tenant mode has no tenant field at
   * all, so there the check is off.
   */
  requireTenant?: boolean
}

/**
 * Slugs are unique per tenant, not globally: two tenants may both have `port-vila`. The
 * tenant is taken from the document being validated, so the check also works for a create
 * made with `overrideAccess` (the seed and the importer).
 */
const validateSlug: Validate = async (value, { data, id, req }) => {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    return 'Use lowercase letters, numbers and single hyphens, for example port-vila'
  }

  const sibling = (data ?? {}) as LocationData
  const tenant = idOf(sibling.tenant)
  // The beforeChange hook has already refused a tenantless document in multi-tenant mode.
  if (tenant === null) return true

  const { docs } = await req.payload.find({
    collection: 'locations',
    depth: 0,
    limit: 2,
    overrideAccess: true,
    pagination: false,
    req,
    where: {
      and: [{ slug: { equals: value } }, { tenant: { equals: tenant } }],
    },
  })

  const ownID = id === undefined || id === null ? null : String(id)
  if (docs.some((doc) => String(doc.id) !== ownID)) {
    return `The slug "${value}" is already used by another location in this tenant`
  }

  return true
}

/**
 * A parent must exist in the same tenant and be a broader kind. A region takes no parent.
 * The check reads the parent with `overrideAccess`, otherwise a tenant admin could not
 * resolve locations outside their own read filter, and compares tenants explicitly.
 */
const validateParent: Validate = async (value, { data, id, req }) => {
  const parentID = idOf(value as LocationRef)
  if (parentID === null) return true

  const sibling = (data ?? {}) as LocationData
  const kind = sibling.kind

  if (!kind) return true

  if (id !== undefined && id !== null && String(parentID) === String(id)) {
    return 'A location cannot be its own parent'
  }

  if (ALLOWED_PARENT_KINDS[kind].length === 0) {
    return `A ${kind} cannot have a parent`
  }

  const parent = (await req.payload.findByID({
    collection: 'locations',
    depth: 0,
    id: parentID,
    overrideAccess: true,
    req,
  })) as LocationData | null

  if (!parent) return 'The parent location does not exist'

  if (!parent.kind || !ALLOWED_PARENT_KINDS[kind].includes(parent.kind)) {
    return `A ${kind}’s parent must be a ${ALLOWED_PARENT_KINDS[kind].join(' or ')}`
  }

  const tenantID = idOf(sibling.tenant)
  // A tenantless child never reaches here in multi-tenant mode: the beforeChange hook
  // refuses it. In single-tenant mode there is no tenant field at all.
  if (tenantID === null) return true

  const parentTenantID = idOf(parent.tenant)

  if (parentTenantID === null) return 'The parent location belongs to no tenant'

  return String(tenantID) === String(parentTenantID)
    ? true
    : 'The parent location belongs to another tenant'
}

const fields: Field[] = [
  {
    name: 'name',
    type: 'text',
    required: true,
  },
  {
    name: 'slug',
    type: 'text',
    required: true,
    index: true,
    validate: validateSlug,
  },
  {
    name: 'kind',
    type: 'select',
    required: true,
    options: locationKindOptions,
  },
  {
    name: 'parent',
    type: 'relationship',
    relationTo: 'locations',
    index: true,
    validate: validateParent,
  },
  {
    name: 'legacyId',
    type: 'number',
    index: true,
    admin: {
      description: 'WordPress id, so the importer can match an existing location.',
    },
  },
]

/**
 * The location tree: regions (roots), islands and towns. Public read, so sites and job
 * alerts can build filters without a session. Only tenant admins and editors write, and the
 * multi-tenant plugin scopes every operation to the caller's tenant.
 */
export const locationsCollection = (options: LocationsOptions = {}): CollectionConfig => {
  const { requireTenant = false } = options

  return {
    slug: 'locations',
    access: {
      create: tenantContentWriteAccess,
      delete: tenantContentWriteAccess,
      read: () => true,
      update: tenantContentWriteAccess,
    },
    admin: {
      defaultColumns: ['name', 'kind', 'slug', 'parent'],
      group: 'Jobs',
      useAsTitle: 'name',
    },
    fields,
    hooks: requireTenant
      ? {
          // A field validator is skipped when its field is not submitted, so a write that never
          // mentions `tenant` would slip past `validateSlug` and `validateParent`. Check the
          // tenant itself here, where every create and update passes. (`beforeChange`, not
          // `beforeValidate`: the plugin's membership hook is the first entry there, and the
          // tenancy test reaches for it by that position.)
          beforeChange: [
            ({ data, originalDoc }) => {
              const tenant = idOf(
                ((data as LocationData | undefined)?.tenant ??
                  (originalDoc as LocationData | undefined)?.tenant) as LocationRef,
              )
              if (tenant === null) {
                throw new ValidationError({
                  collection: 'locations',
                  errors: [{ message: 'A location must belong to a tenant', path: 'tenant' }],
                })
              }

              return data
            },
          ],
        }
      : {},
    versions: false,
  }
}

/**
 * Per-tenant slug uniqueness, enforced by the database as well as by `validateSlug`. Only
 * applied in multi-tenant mode: the `tenant` field is added by the multi-tenant plugin, so
 * the index would be invalid in single-tenant mode.
 */
export const locationsTenantSlugIndex: CompoundIndex = {
  fields: ['tenant', 'slug'],
  unique: true,
}
