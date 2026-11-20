import type { CollectionConfig, CompoundIndex, Field, PayloadRequest, Validate, CollectionSlug } from 'payload'
import { ValidationError } from 'payload'

import { tenantContentWriteAccess } from '../access'
import { assertUniqueSlug, slugConflict, type SlugRules } from '../slug-rules'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import type { TenantLocationSettings } from '../location-settings'

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The collection's own slug, also used for the parent relation and the lookups. */
const DEFAULT_SLUG = 'locations'

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
  parent?: LocationRef
  slug?: null | string
  tenant?: LocationRef
}

const idOf = (value: LocationRef): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value.id ?? null

  return value
}

/**
 * A tenant's location settings, read when a write needs its maximum depth. The plugin supplies
 * this from the tenants collection (multi) or the job-board settings global (single), so the
 * collection itself stays independent of where settings live.
 */
export type LocationLimits = (args: {
  data: LocationData
  req: PayloadRequest
}) => Promise<null | TenantLocationSettings> | null | TenantLocationSettings

export type LocationsOptions = {
  /** Overrides the collection's default access, operation by operation. */
  access?: CollectionAccess
  /**
   * Refuse a location deeper than the tenant allows. Optional: a tenant without a limit can
   * build any tree.
   */
  limits?: LocationLimits
  /**
   * In multi-tenant mode every location must name a tenant. The tenant is what scopes the
   * slug and the parent comparison, so a tenantless row would sit outside the tenant tree
   * (and its parent could belong to any tenant). Single-tenant mode has no tenant field at
   * all, so there the check is off.
   */
  requireTenant?: boolean
  /** Overrides the collection slug. Defaults to `locations`. */
  slug?: string
  /**
   * Slugs shared with job categories and job types, and the reserved words (PJ-98). Without
   * it a location slug only has to be unique among locations.
   */
  slugRules?: SlugRules
}

/**
 * Slugs are unique per tenant, not globally: two tenants may both have `port-vila`. The
 * tenant is taken from the document being validated, so the check also works for a create
 * made with `overrideAccess` (the seed and the importer).
 */
const validateSlug = (collectionSlug: string, rules?: SlugRules, requireTenant = false): Validate => async (value, { data, id, req }) => {
  if (typeof value !== 'string' || !SLUG.test(value)) {
    return 'Use lowercase letters, numbers and single hyphens, for example port-vila'
  }

  const sibling = (data ?? {}) as LocationData
  const tenant = idOf(sibling.tenant)
  // A tenantless document is refused by the beforeChange hook in multi-tenant mode. In
  // single-tenant mode there is no tenant to scope to: the shared rules still apply, across the
  // whole collection. Without shared rules the legacy behaviour (no check) is kept.
  if (tenant === null && (requireTenant || !rules)) return true

  const conflict = await slugConflict({
    collection: collectionSlug,
    req,
    rules: rules ?? { namespaces: [{ collection: collectionSlug, label: 'location' }], reserved: [] },
    selfID: id,
    slug: value,
    tenant,
  })
  return conflict ?? true
}

type TreeCheckArgs = {
  /** The document as it will be stored: submitted data merged over the stored document. */
  data: LocationData
  id?: number | string
  limits?: LocationLimits
  req: PayloadRequest
}

type ParentCheck = { depth: number; error?: undefined } | { depth?: undefined; error: string }

/** A limit on how far an ancestor walk goes, so corrupt data cannot spin forever. */
const MAX_TREE_WALK = 1000

const readLocation = async (
  id: number | string,
  req: PayloadRequest,
  collectionSlug: string,
): Promise<LocationData | null> =>
  (await req.payload.findByID({
    collection: collectionSlug as CollectionSlug,
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })) as LocationData | null

/**
 * A parent must exist in the same tenant and the tree may not loop. There is no fixed kind
 * ladder any more, so the check walks the parent chain: the document cannot be moved under
 * one of its own descendants, and a parent chain that already loops is refused rather than
 * followed forever. The walk also counts the ancestors, which is the stored `depth`.
 *
 * The check reads parents with `overrideAccess`, otherwise a tenant admin could not resolve
 * locations outside their own read filter, and compares tenants explicitly.
 */
const checkParent = async (
  value: LocationRef,
  { data, id, limits, req }: TreeCheckArgs,
  collectionSlug: string,
): Promise<ParentCheck> => {
  const parentID = idOf(value)
  let depth = 0
  let parent: LocationData | null = null

  if (parentID !== null) {
    if (id !== undefined && id !== null && String(parentID) === String(id)) {
      return { error: 'A location cannot be its own parent' }
    }

    // Walk up from the parent. Reaching the document itself means the new parent is one of
    // its descendants; a repeated id means the stored tree already loops.
    const seen = new Set<string>()
    let currentID: null | number | string = parentID

    while (currentID !== null) {
      const key = String(currentID)
      if (id !== undefined && id !== null && key === String(id)) {
        return { error: 'A location cannot sit under one of its own descendants' }
      }
      if (seen.has(key)) return { error: 'The location tree loops; fix the parents before saving' }
      if (seen.size >= MAX_TREE_WALK) return { error: 'The location tree is deeper than allowed' }
      seen.add(key)

      const doc = await readLocation(currentID, req, collectionSlug)
      if (!doc) {
        return { error: depth === 0 ? 'The parent location does not exist' : 'An ancestor location is missing' }
      }

      if (depth === 0) parent = doc
      depth += 1
      currentID = idOf(doc.parent)
    }

    const tenantID = idOf(data.tenant)
    // A tenantless child never reaches here in multi-tenant mode: the beforeChange hook
    // refuses it. In single-tenant mode there is no tenant field at all.
    if (tenantID !== null) {
      const parentTenantID = idOf(parent?.tenant)

      if (parentTenantID === null) return { error: 'The parent location belongs to no tenant' }
      if (String(tenantID) !== String(parentTenantID)) {
        return { error: 'The parent location belongs to another tenant' }
      }
    }
  }

  if (limits) {
    const settings = await limits({ data, req })
    const maxDepth = settings?.maxDepth ?? null

    if (maxDepth !== null && depth > maxDepth) {
      const named = settings?.levels.length
        ? ` (${settings.levels.slice(0, maxDepth + 1).join(' → ')})`
        : ''
      const levelWord = maxDepth === 0 ? 'level' : 'levels'

      return { error: `This tenant allows at most ${maxDepth + 1} location ${levelWord}${named}` }
    }
  }

  return { depth }
}

/**
 * Field validators only run for fields the request submits, so an update that changes nothing
 * but leaves a stored parent invalid would skip this check. The collection-level `beforeChange`
 * hook below therefore runs the same check against the merged document on every write, and this
 * validator only covers the field-level error message.
 */
const validateParent = (collectionSlug: string): Validate => async (value, { data, id, req }) => {
  const result = await checkParent(
    value as LocationRef,
    {
      data: (data ?? {}) as LocationData,
      id,
      req,
    },
    collectionSlug,
  )

  return result.error ?? true
}

const fields = (collectionSlug: string, rules?: SlugRules, requireTenant = false): Field[] => [
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
    validate: validateSlug(collectionSlug, rules, requireTenant),
  },
  {
    name: 'parent',
    type: 'relationship',
    relationTo: collectionSlug as CollectionSlug,
    index: true,
    validate: validateParent(collectionSlug),
  },
  {
    name: 'depth',
    type: 'number',
    index: true,
    admin: {
      description:
        'Computed from the parent chain: 0 is the top level (Island on Vanuatu Wok), 1 its children, and so on.',
      readOnly: true,
    },
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
 * The generic location tree: any depth, any level names. Public read, so sites and job alerts
 * can build filters without a session. Only tenant admins and editors write, and the
 * multi-tenant plugin scopes every operation to the caller's tenant.
 */
export const locationsCollection = (options: LocationsOptions = {}): CollectionConfig => {
  const { access, limits, requireTenant = false, slug = DEFAULT_SLUG, slugRules } = options

  return {
    slug,
    access: mergeCollectionAccess(
      {
        create: tenantContentWriteAccess,
        delete: tenantContentWriteAccess,
        read: () => true,
        update: tenantContentWriteAccess,
      },
      access,
    ),
    admin: {
      defaultColumns: ['name', 'depth', 'slug', 'parent'],
      group: 'Jobs',
      useAsTitle: 'name',
    },
    fields: fields(slug, slugRules, requireTenant),
    hooks: {
      // Field validators are skipped when their field is not submitted, so a write that never
      // mentions `tenant` or `parent` would slip past `validateSlug` and `validateParent`.
      // Check both here, against the document as it will be stored, and persist the computed
      // depth. (`beforeChange`, not `beforeValidate`: the plugin's membership hook is the first
      // entry there, and the tenancy test reaches for it by that position.)
      beforeChange: [
        async ({ data, originalDoc, req }) => {
          const submitted = (data ?? {}) as LocationData
          const stored = (originalDoc ?? {}) as LocationData
          const merged: LocationData = { ...stored, ...submitted }

          if (requireTenant && idOf(merged.tenant) === null) {
            throw new ValidationError({
              collection: slug,
              errors: [{ message: 'A location must belong to a tenant', path: 'tenant' }],
            })
          }

          // The slug validator only runs when `slug` is submitted. Moving a location to another
          // tenant submits only `tenant`, so check the stored slug against the destination.
          if (slugRules && submitted.slug === undefined && submitted.tenant !== undefined) {
            if (typeof merged.slug === 'string') {
              await assertUniqueSlug({
                collection: slug,
                req,
                rules: slugRules,
                selfID: merged.id ?? stored.id,
                slug: merged.slug,
                tenant: idOf(merged.tenant),
              })
            }
          }

          const result = await checkParent(
            merged.parent,
            {
              data: merged,
              id: merged.id ?? stored.id,
              limits,
              req,
            },
            slug,
          )
          if (result.error !== undefined) {
            throw new ValidationError({
              collection: slug,
              errors: [{ message: result.error, path: 'parent' }],
            })
          }

          return { ...submitted, depth: result.depth }
        },
      ],
      afterChange: [
        // Moving a branch changes the depth of everything under it. Each child is saved again
        // so its own beforeChange recomputes the depth from the parent chain, and its
        // afterChange carries the move on to the grandchildren.
        async ({ doc, operation, previousDoc, req }) => {
          if (operation !== 'update') return doc
          if (String(previousDoc?.depth ?? '') === String(doc?.depth ?? '')) return doc

          const children = await req.payload.find({
            collection: slug as CollectionSlug,
            depth: 0,
            limit: 0,
            overrideAccess: true,
            pagination: false,
            req,
            where: { parent: { equals: doc.id } },
          })

          for (const child of children.docs) {
            await req.payload.update({
              collection: slug as CollectionSlug,
              data: {},
              depth: 0,
              id: child.id,
              overrideAccess: true,
              req,
            })
          }

          return doc
        },
      ],
    },
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
