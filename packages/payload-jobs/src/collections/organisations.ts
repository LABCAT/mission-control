import {
  ValidationError,
  type Access,
  type AccessResult,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type FieldAccess,
  type PayloadRequest,
  type Validate,
  type Where,
} from 'payload'

import {
  getUserOrganisationID,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type TenantRole,
} from '../access'
import { seoCollapsible } from '../seo-fields'
import { getSiteKeyHeader, resolveSiteKey } from '../site-keys'
import { mergeCollectionAccess, type CollectionAccess } from '../slugs'
import { uniqueSlugPerTenant, validateTaxonomySlug } from '../taxonomies'

/**
 * Organisations (PJ-18). In WordPress an employer *was* an organisation: the profile lived in
 * user meta on a `job_lister` account (AUDIT.md). Here an organisation is a document of its
 * own, and employer users point at it through `users.organisation`, so a business can hire
 * through several accounts later without copying its profile.
 */

export const ORGANISATIONS_SLUG = 'organisations'

export const ORGANISATION_TYPES = [
  'business',
  'government',
  'nfp',
  'consultant',
  'recruiter',
  'social-enterprise',
] as const

export type OrganisationType = (typeof ORGANISATION_TYPES)[number]

const typeLabels: Record<OrganisationType, string> = {
  business: 'Business',
  consultant: 'Consultant',
  government: 'Government',
  nfp: 'Not-for-profit',
  recruiter: 'Recruiter',
  'social-enterprise': 'Social enterprise',
}

export const organisationTypeOptions = ORGANISATION_TYPES.map((value) => ({
  label: typeLabels[value],
  value,
}))

/** Size bands, as the legacy site's directory filtered on them. Values are URL-safe. */
export const ORGANISATION_SIZES = ['1-10', '11-50', '51-200', '201-500', '500-plus'] as const

export type OrganisationSize = (typeof ORGANISATION_SIZES)[number]

const sizeLabels: Record<OrganisationSize, string> = {
  '1-10': '1–10 people',
  '11-50': '11–50 people',
  '51-200': '51–200 people',
  '201-500': '201–500 people',
  '500-plus': '500+ people',
}

export const organisationSizeOptions = ORGANISATION_SIZES.map((value) => ({
  label: sizeLabels[value],
  value,
}))

/** Staff roles that maintain any organisation in their tenants. */
export const ORGANISATION_EDITOR_ROLES = [
  'tenant-admin',
  'editor',
] as const satisfies readonly TenantRole[]

/**
 * Roles that may set the fields the employer must not touch: page approval, the listing
 * request's outcome and billing. An employer may edit their own profile, not their own
 * approval or invoice terms.
 */
export const ORGANISATION_ADMIN_ROLES = ['tenant-admin'] as const satisfies readonly TenantRole[]

/**
 * Roles that may hold an organisation. Seeking is not one: a seeker membership in an
 * organisation's tenant must never widen what a user can read or edit there.
 */
export const ORGANISATION_HOLDER_ROLES = [
  'tenant-admin',
  'editor',
  'employer',
] as const satisfies readonly TenantRole[]

/**
 * What a public site may see (PJ-38, decided 19 Nov). Pages are private until the page is
 * switched on, and an organisation flagged as a possible duplicate is never public, whatever its
 * flags say. Where the tenant requires approval (vwok: the lister requests, an admin approves,
 * AUDIT.md) the admin's `approved` is needed as well.
 */
export const publicOrganisationFilter = (needsApproval: boolean): Where => ({
  and: [
    { pageEnabled: { equals: true } },
    { possibleDuplicate: { not_equals: true } },
    ...(needsApproval ? [{ approved: { equals: true } }] : []),
  ],
})

/** The strict filter: approval required. Used where a request spans tenants (aggregate keys). */
export const PUBLIC_ORGANISATION_FILTER: Where = publicOrganisationFilter(true)

/** The tenant setting's name, and its default: vwok's legacy behaviour is approval ON. */
export const ORGANISATION_PAGES_NEED_APPROVAL = 'organisationPagesNeedApproval'

type OrganisationPublicState = {
  approved?: boolean | null
  pageEnabled?: boolean | null
  possibleDuplicate?: boolean | null
}

/** The rule above for one organisation in hand (an import check, a unit test, a stub page). */
export const isOrganisationPublic = (
  organisation: null | OrganisationPublicState | undefined,
  { needsApproval = true }: { needsApproval?: boolean } = {},
): boolean =>
  Boolean(organisation) &&
  organisation?.pageEnabled === true &&
  organisation.possibleDuplicate !== true &&
  (!needsApproval || organisation.approved === true)

/**
 * Whether a tenant's organisation pages need an admin's approval. One lookup per request. A
 * tenant that cannot be read keeps the strict default.
 */
const needsApprovalFor = async (
  req: PayloadRequest,
  tenantsSlug: string,
  tenantID: number | string,
): Promise<boolean> => {
  const context = (req.context ??= {})
  const cache = ((context.missionControlOrgApproval as Map<string, Promise<boolean>> | undefined) ??=
    new Map())
  const key = `${tenantsSlug}:${String(tenantID)}`
  const cached = cache.get(key)
  if (cached) return cached

  const lookup = (async (): Promise<boolean> => {
    let tenant: null | Record<string, unknown> = null
    try {
      tenant = (await req.payload.findByID({
        collection: tenantsSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: tenantID,
        overrideAccess: true,
        req,
      })) as null | Record<string, unknown>
    } catch {
      // Unreadable: keep the strict default below.
    }
    return tenant?.[ORGANISATION_PAGES_NEED_APPROVAL] !== false
  })()

  cache.set(key, lookup)
  return lookup
}

const tenantIDOf = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return (tenant as { id?: number | string }).id ?? null
  return tenant as number | string
}

/** True when the write data carries a `tenant` key at all, even `null` or `undefined`. */
const submitsTenant = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && Object.prototype.hasOwnProperty.call(data, 'tenant')

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const hasCollection = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload?.collections as Record<string, unknown> | undefined)?.[slug])

/**
 * The organisations a user sees in multi-tenant mode: their staff tenants, plus the one their
 * user points at — but only while they still hold a role that can own it there. A link left
 * behind after a membership drops to seeker must not keep the profile open. `false` when
 * neither applies.
 */
const organisationScopes = (
  user: MissionControlUser,
  ownOrganisation: null | number | string,
): AccessResult => {
  const scopes: Where[] = []
  const staffTenants = getUserTenantIDsByRole(user, ORGANISATION_EDITOR_ROLES)
  const holderTenants = getUserTenantIDsByRole(user, ORGANISATION_HOLDER_ROLES)

  if (staffTenants.length > 0) scopes.push({ tenant: { in: staffTenants } })

  if (ownOrganisation !== null && holderTenants.length > 0) {
    scopes.push({ and: [{ id: { equals: ownOrganisation } }, { tenant: { in: holderTenants } }] })
  }

  if (scopes.length === 0) return false
  return scopes.length === 1 ? scopes[0] : { or: scopes }
}

const idsOf = (value: unknown): (number | string)[] =>
  (Array.isArray(value) ? value : [value])
    .map((entry) => tenantIDOf(entry))
    .filter((id): id is number | string => id !== null)

/**
 * Read access.
 * - Super admins: every organisation.
 * - Tenant admins and editors: every organisation in their tenants.
 * - Employers: only the organisation on their user.
 * - Anonymous with a valid site key: the tenant's public organisations (see
 *   `publicOrganisationFilter`; every tenant for an aggregate key). Without a key: nothing.
 * - Seekers: nothing they could not see on the site, and site reads carry a key.
 *
 * In multi-tenant mode the plugin also ANDs `tenant in <user's tenants>` onto a user's result.
 */
export const organisationReadAccess =
  (tenantScoped: boolean, tenantsSlug = 'tenants'): Access =>
  async ({ req }) => {
    const user = userOf(req)

    if (!user) {
      // Site keys are a host collection; in single-tenant mode there is nothing to resolve, and
      // the public reads the collection through whatever the host exposes.
      if (!tenantScoped || !getSiteKeyHeader(req) || !hasCollection(req, 'site-keys')) return false

      const siteKey = await resolveSiteKey(req)
      if (!siteKey) return false
      // An aggregate key spans tenants, so it keeps the strict rule.
      if (siteKey.isAggregate) return PUBLIC_ORGANISATION_FILTER

      const needsApproval = await needsApprovalFor(req, tenantsSlug, siteKey.tenantID)

      return {
        and: [{ tenant: { equals: siteKey.tenantID } }, publicOrganisationFilter(needsApproval)],
      }
    }

    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    const ownOrganisation = getUserOrganisationID(user)

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, ORGANISATION_EDITOR_ROLES)) return true
      return ownOrganisation === null ? false : { id: { equals: ownOrganisation } }
    }

    return organisationScopes(user, ownOrganisation)
  }

/**
 * Create is for staff: an employer account is made together with its organisation by the
 * sign-up endpoint (PJ-29), which runs with `overrideAccess`. A `where` result doesn't filter
 * create data, so the submitted tenant is checked here.
 */
export const organisationCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (!tenantScoped) return isSuperAdmin(user) || hasAnyTenantRole(user, ORGANISATION_EDITOR_ROLES)

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    if (isSuperAdmin(user)) return true

    return getUserTenantIDsByRole(user, ORGANISATION_EDITOR_ROLES).some(
      (id) => String(id) === String(submitted),
    )
  }

/**
 * Update: staff anywhere in their tenants, employers on their own organisation only. The
 * field-level rules below keep an employer out of the admin-only fields, and the multi-tenant
 * plugin keeps everyone inside the tenants they belong to.
 */
export const organisationUpdateAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    const ownOrganisation = getUserOrganisationID(user)

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, ORGANISATION_EDITOR_ROLES)) return true
      return ownOrganisation === null ? false : { id: { equals: ownOrganisation } }
    }

    return organisationScopes(user, ownOrganisation)
  }

/** Deleting an organisation loses its billing history, so only tenant admins may. */
export const organisationDeleteAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true

    const adminTenants = getUserTenantIDsByRole(user, ORGANISATION_ADMIN_ROLES)
    if (adminTenants.length === 0) return false

    return tenantScoped ? { tenant: { in: adminTenants } } : true
  }

/**
 * Approval, page visibility and billing terms are tenant-admin fields, checked against the
 * organisation's own tenant: an employer in tenant A who happens to administer an unrelated
 * tenant B can still edit their own organisation, so "admin somewhere" is not enough.
 *
 * Unscoped, the check falls back to the bare role. Single-tenant mode has no tenant to compare,
 * and the `users.organisation` field has no tenant of its own.
 */
export const organisationAdminFieldAccess =
  (tenantScoped = true): FieldAccess =>
  ({ data, doc, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true

    const adminTenants = getUserTenantIDsByRole(user, ORGANISATION_ADMIN_ROLES)
    if (adminTenants.length === 0) return false
    if (!tenantScoped) return true

    const target = tenantIDOf(doc?.tenant ?? (data as { tenant?: unknown } | undefined)?.tenant)
    if (target === null) return false

    return adminTenants.some((tenantID) => String(tenantID) === String(target))
  }

const URL_PATTERN = /^https?:\/\/[^\s/]+\.[^\s]+$/i

export const validateUrl = (value: null | string | undefined): string | true =>
  !value || URL_PATTERN.test(value.trim())
    ? true
    : 'Use a full web address starting with http:// or https://'

export const validateOrganisationSlug = (value: null | string | undefined): string | true => {
  const result = validateTaxonomySlug(value)
  return result === true
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example vanuatu-brewing'
}

/**
 * The profile's relations must point inside the organisation's own tenant. The admin pickers
 * are filtered by the multi-tenant plugin, but a REST or local API write could still name
 * another tenant's locations, media or areas of focus.
 */
export const organisationRelationsInTenant =
  (
    tenantScoped: boolean,
    mediaSlug: null | string = 'media',
    locationsSlug = 'locations',
  ): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data

    const tenantID = tenantIDOf(submitsTenant(data) ? data.tenant : originalDoc?.tenant)
    // The plugin's membership hook refuses a tenantless organisation.
    if (tenantID === null) return data

    const errors: { message: string; path: string }[] = []

    const relations: { label: string; path: string; relationTo: CollectionSlug }[] = [
      { label: 'location', path: 'location', relationTo: locationsSlug as CollectionSlug },
    ]
    if (mediaSlug) {
      relations.push(
        { label: 'cover image', path: 'cover', relationTo: mediaSlug as CollectionSlug },
        { label: 'logo', path: 'logo', relationTo: mediaSlug as CollectionSlug },
      )
    }

    for (const { label, path, relationTo } of relations) {
      // An omitted field keeps its stored relations; an explicit `null` clears them.
      const submitted = data && Object.prototype.hasOwnProperty.call(data, path)
      const ids = idsOf(submitted ? data?.[path] : originalDoc?.[path])
      if (ids.length === 0) continue

      const { totalDocs } = await req.payload.count({
        collection: relationTo,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: ids } }, { tenant: { equals: tenantID } }] },
      })
      if (totalDocs !== new Set(ids.map(String)).size) {
        errors.push({ message: `Pick a ${label} from this organisation’s tenant`, path })
      }
    }

    if (errors.length > 0) throw new ValidationError({ collection: collection.slug, errors, req })
    return data
  }

const valueAfterWrite = (
  data: Record<string, unknown> | undefined,
  originalDoc: Record<string, unknown> | undefined,
  name: string,
): unknown =>
  data && Object.prototype.hasOwnProperty.call(data, name) ? data[name] : originalDoc?.[name]

/**
 * A possible duplicate cannot have a public page (PJ-38): two organisations competing for one
 * name on the directory is the problem the flag marks. Clear the flag (or merge) first.
 */
export const duplicateCannotBePublic =
  (collectionSlug = ORGANISATIONS_SLUG): CollectionBeforeChangeHook =>
  ({ data, originalDoc, req }) => {
    const doc = originalDoc as Record<string, unknown> | undefined
    const submitted = data as Record<string, unknown> | undefined

    if (
      valueAfterWrite(submitted, doc, 'possibleDuplicate') === true &&
      valueAfterWrite(submitted, doc, 'pageEnabled') === true
    ) {
      throw new ValidationError({
        collection: collectionSlug as CollectionSlug,
        errors: [
          {
            message: 'A possible duplicate cannot have a public page until the duplicate is resolved',
            path: 'pageEnabled',
          },
        ],
        req,
      })
    }

    return data
  }

/**
 * An organisation belongs to exactly one tenant, and moving it would take its jobs, orders and
 * page with it. The multi-tenant plugin's tenant field lets any member of the collection point a
 * document at a tenant they belong to, so an employer in two tenants could move their own
 * organisation. Only a tenant admin of *both* the tenant it leaves and the one it joins may
 * re-assign it: an admin of an unrelated tenant decides nothing about either.
 */
export const organisationTenantIsStable =
  (tenantScoped: boolean, collectionSlug = ORGANISATIONS_SLUG): CollectionBeforeChangeHook =>
  ({ data, operation, originalDoc, req }) => {
    if (!tenantScoped || operation !== 'update' || !originalDoc) return data
    if (!submitsTenant(data)) return data

    const submitted = tenantIDOf(data.tenant)
    const stored = tenantIDOf(originalDoc.tenant)
    if (submitted === null || String(submitted) === String(stored)) return data

    // No user is a system write: an `overrideAccess` call from the importer or a seed.
    const user = userOf(req)
    if (!user) return data
    if (isSuperAdmin(user)) return data

    const adminTenants = getUserTenantIDsByRole(user, ORGANISATION_ADMIN_ROLES)
    const isAdminOf = (id: null | number | string): boolean =>
      id !== null && adminTenants.some((tenantID) => String(tenantID) === String(id))

    if (isAdminOf(stored) && isAdminOf(submitted)) return data

    throw new ValidationError({
      collection: collectionSlug as CollectionSlug,
      errors: [
        {
          message: 'Only a tenant admin of both tenants can move an organisation',
          path: 'tenant',
        },
      ],
      req,
    })
  }

/** Write-only: the employer still sees whether their page is live. */
const adminOnlyFor = (tenantScoped: boolean) => {
  const access = organisationAdminFieldAccess(tenantScoped)
  return { create: access, update: access }
}

/** Billing terms and the legacy id are not the employer's business, so reads are hidden too. */
const adminOnlyForReads = (tenantScoped: boolean) => {
  const write = adminOnlyFor(tenantScoped)
  return { ...write, read: write.update }
}

const imageFields = (mediaSlug: string): Field[] => [
  {
    name: 'logo',
    type: 'upload',
    relationTo: mediaSlug as CollectionSlug,
    admin: { description: 'Shown in the directory and on the organisation page.' },
  },
  {
    name: 'cover',
    type: 'upload',
    relationTo: mediaSlug as CollectionSlug,
    admin: { description: 'Wide banner at the top of the organisation page.' },
  },
]

/**
 * The page slug is unique per tenant in multi-tenant mode, and unique across the site when the
 * tenant scope is off. The compound index covers the first case; this hook reports the clash
 * with a readable message instead of a database error.
 */
export const uniqueOrganisationSlug =
  (tenantScoped: boolean, collectionSlug = ORGANISATIONS_SLUG): CollectionBeforeValidateHook =>
  async (args) => {
    if (tenantScoped) return uniqueSlugPerTenant(collectionSlug as CollectionSlug)(args)

    const { data, originalDoc, req } = args
    const slug = typeof data?.slug === 'string' ? data.slug.trim() : ''
    if (!slug) return data

    const selfID = originalDoc?.id
    const { docs } = await req.payload.find({
      collection: collectionSlug as CollectionSlug,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: { slug: { equals: slug } },
    })

    const conflict = docs.some((doc) => selfID === undefined || String(doc.id) !== String(selfID))
    if (!conflict) return data

    throw new ValidationError({
      collection: collectionSlug as CollectionSlug,
      errors: [{ message: `Slug "${slug}" is already used`, path: 'slug' }],
      req,
    })
  }

const profileFields = (
  mediaSlug: null | string,
  tenantScoped: boolean,
  locationsSlug: string,
): Field[] => {
  const adminOnly = adminOnlyFor(tenantScoped)
  const billingOnly = adminOnlyForReads(tenantScoped)

  return [
  {
    name: 'name',
    type: 'text',
    required: true,
  },
  {
    name: 'slug',
    type: 'text',
    // Single-tenant sites have no tenant to scope the slug to, so the column alone is unique.
    index: true,
    required: true,
    unique: !tenantScoped,
    validate: validateOrganisationSlug,
    admin: {
      description: tenantScoped
        ? 'Used in the organisation page URL. Unique within the tenant.'
        : 'Used in the organisation page URL. Unique across the site.',
    },
  },
  {
    type: 'row',
    fields: [
      {
        name: 'type',
        type: 'select',
        index: true,
        options: organisationTypeOptions,
      },
      {
        name: 'size',
        type: 'select',
        options: organisationSizeOptions,
      },
    ],
  },
  {
    name: 'about',
    type: 'textarea',
  },
  ...(mediaSlug ? [{ type: 'collapsible', label: 'Images', fields: imageFields(mediaSlug) } as Field] : []),
  {
    type: 'collapsible',
    label: 'Contact',
    fields: [
      {
        name: 'website',
        type: 'text',
        validate: validateUrl,
      },
      {
        name: 'phone',
        type: 'text',
      },
      {
        name: 'location',
        type: 'relationship',
        relationTo: locationsSlug as CollectionSlug,
        admin: {
          description: 'The tenant’s location tree, not a free-text address.',
        },
      },
      {
        name: 'socials',
        type: 'group',
        fields: [
          { name: 'facebook', type: 'text', validate: validateUrl },
          { name: 'instagram', type: 'text', validate: validateUrl },
          { name: 'linkedin', type: 'text', validate: validateUrl },
          { name: 'x', type: 'text', validate: validateUrl },
          { name: 'youtube', type: 'text', validate: validateUrl },
        ],
      },
    ],
  },
  {
    type: 'collapsible',
    label: 'Public page',
    fields: [
      {
        name: 'listingRequested',
        type: 'checkbox',
        defaultValue: false,
        admin: {
          description: 'The employer has asked for a public page. The admin is notified.',
        },
      },
      {
        name: 'approved',
        type: 'checkbox',
        defaultValue: false,
        access: adminOnly,
        admin: {
          description: 'Set by a tenant admin. Unapproved organisations cannot publish jobs.',
        },
      },
      {
        name: 'trusted',
        type: 'checkbox',
        defaultValue: false,
        access: adminOnly,
        admin: {
          description:
            'Set by a site manager. A trusted organisation’s jobs follow the site’s “trusted” go-live rule (usually live at once, invoice paid later); others wait for approval. Approving a job can set this (site setting).',
        },
      },
      {
        name: 'pageEnabled',
        type: 'checkbox',
        defaultValue: false,
        access: adminOnly,
        admin: {
          description:
            'Private by default. Switch on to put the public page and directory entry live (needs approval where the tenant requires it).',
        },
      },
      {
        name: 'possibleDuplicate',
        type: 'checkbox',
        defaultValue: false,
        access: adminOnly,
        admin: {
          description:
            'Flagged as a possible duplicate of another organisation. Its page cannot be public, and its jobs stay off any official page, until a site manager merges or clears it.',
        },
      },
    ],
  },
  {
    type: 'collapsible',
    label: 'Billing',
    admin: {
      description: 'Tenant admins only.',
    },
    fields: [
      {
        name: 'canPayByInvoice',
        type: 'checkbox',
        defaultValue: false,
        access: billingOnly,
        admin: { description: 'Known customers pay by invoice instead of at checkout.' },
      },
      {
        name: 'billingEmail',
        type: 'email',
        access: billingOnly,
        admin: { description: 'Receives invoices. Falls back to the account email when empty.' },
      },
      {
        name: 'xeroContactCode',
        type: 'text',
        access: billingOnly,
        admin: { description: 'Xero contact for this organisation, used by invoice orders.' },
      },
    ],
  },
  // The one SEO group (PJ-104). An organisation page is indexed unless this says otherwise, and
  // its structured data is generated from the profile, never typed in here.
  seoCollapsible({ mediaSlug }),
  {
    name: 'legacyId',
    type: 'number',
    index: true,
    access: billingOnly,
    admin: {
      description: 'WordPress user id of the legacy employer, for the import.',
      position: 'sidebar',
    },
  },
  ]
}

export type OrganisationsOptions = {
  /** Overrides the collection's default access, operation by operation. */
  access?: CollectionAccess
  /** Resolved slug of the locations collection. Defaults to `locations`. */
  locationsSlug?: string
  /**
   * Slug of the host's upload collection for `logo` and `cover`. `null` drops the images,
   * for a config without uploads.
   */
  mediaSlug?: null | string
  /** Overrides the collection slug. Defaults to `organisations`. */
  slug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
  /** Slug of the tenants collection, read for the page-approval setting. Defaults to `tenants`. */
  tenantsSlug?: string
}

/**
 * The organisation profiles employers edit in the admin and the public site reads.
 * Tenant-scoped: the multi-tenant plugin adds the `tenant` field and the tenant filter.
 */
export const organisationsCollection = ({
  access,
  locationsSlug = 'locations',
  mediaSlug = 'media',
  slug = ORGANISATIONS_SLUG,
  tenantScoped = true,
  tenantsSlug = 'tenants',
}: OrganisationsOptions = {}): CollectionConfig => ({
  slug,
  access: mergeCollectionAccess(
    {
      create: organisationCreateAccess(tenantScoped),
      delete: organisationDeleteAccess(tenantScoped),
      read: organisationReadAccess(tenantScoped, tenantsSlug),
      update: organisationUpdateAccess(tenantScoped),
    },
    access,
  ),
  admin: {
    defaultColumns: ['name', 'type', 'slug', 'approved', 'pageEnabled'],
    description:
      'Employer profiles. An employer edits their own; tenant admins approve them and set billing.',
    group: 'Job board',
    useAsTitle: 'name',
  },
  fields: profileFields(mediaSlug, tenantScoped, locationsSlug),
  hooks: {
    beforeChange: [
      organisationRelationsInTenant(tenantScoped, mediaSlug, locationsSlug),
      organisationTenantIsStable(tenantScoped, slug),
      duplicateCannotBePublic(slug),
    ],
    beforeValidate: [uniqueOrganisationSlug(tenantScoped, slug)],
  },
  // The unique index spans the tenant, so the same slug may exist on two tenants.
  indexes: tenantScoped ? [{ fields: ['tenant', 'slug'], unique: true }] : [],
  labels: { plural: 'Organisations', singular: 'Organisation' },
  versions: false,
})

/** Tenants where the user holds a role that can own an organisation, as strings for comparison. */
const organisationHoldersTenantsOf = (user: Record<string, unknown> | undefined): Set<string> =>
  new Set(
    getUserTenantIDsByRole(user as MissionControlUser | undefined, ORGANISATION_HOLDER_ROLES).map(
      String,
    ),
  )

const organisationTenantOf = async (
  organisationID: number | string,
  req: PayloadRequest,
  collectionSlug: string,
): Promise<{ error: string } | { tenant: null | number | string }> => {
  const organisation = (await req.payload.findByID({
    collection: collectionSlug as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: organisationID,
    overrideAccess: true,
    req,
  })) as null | { tenant?: unknown }
  if (!organisation) return { error: 'Pick an existing organisation' }

  return { tenant: tenantIDOf(organisation.tenant) }
}

/**
 * An employer's organisation must belong to a tenant where that user may hold one — an employer
 * or staff membership, not a seeker one — and only an admin of that tenant may make the link.
 * Field access only says *who* may write the field; without this an admin of tenant A could
 * point a user at a tenant B organisation, which would then let them edit it there.
 *
 * A super admin acting has no tenant membership, so the link is theirs to set, and a system
 * write (no user, `overrideAccess`) — the importer or the sign-up endpoint — is let through.
 */
export const checkOrganisationLink = async (
  organisationID: number | string,
  user: Record<string, unknown> | null | undefined,
  req: PayloadRequest,
  collectionSlug = ORGANISATIONS_SLUG,
): Promise<string | true> => {
  const found = await organisationTenantOf(organisationID, req, collectionSlug)
  if ('error' in found) return found.error
  if (found.tenant === null) return true

  const tenant = String(found.tenant)

  const actor = userOf(req)
  if (!actor) return true
  if (isSuperAdmin(actor)) return true

  const actorAdminTenants = getUserTenantIDsByRole(actor, ORGANISATION_ADMIN_ROLES)
  if (!actorAdminTenants.some((id) => String(id) === tenant)) {
    return 'Only an admin of the organisation’s tenant can link this user to it'
  }

  if (organisationHoldersTenantsOf(user ?? undefined).has(tenant)) return true

  return 'Pick an organisation from a tenant where this user is an employer'
}

export const organisationMatchesUserTenantsWith =
  (organisationSlug = ORGANISATIONS_SLUG): Validate =>
  async (value, { collectionSlug, data, id, operation, req }) => {
    if (value === null || value === undefined) return true

    const organisationID = idsOf(value)[0]
    if (organisationID === undefined) return true

    const submitted = data as Record<string, unknown>
    const user =
      submitted.tenants === undefined && operation === 'update' && id !== undefined
        ? ((await req.payload.findByID({
            collection: (collectionSlug ??
              req.payload.config.admin?.user ??
              'users') as CollectionSlug,
            depth: 0,
            disableErrors: true,
            id,
            overrideAccess: true,
            req,
          })) as null | Record<string, unknown>)
        : submitted

    return checkOrganisationLink(organisationID, user, req, organisationSlug)
  }

/** The validator with the default organisation slug; `organisationField` binds a custom one. */
export const organisationMatchesUserTenants: Validate = organisationMatchesUserTenantsWith()

/**
 * The relation an employer user gets to their organisation. Added to the users collection by
 * the plugin. Only staff may move a user to another organisation: an employer must not be able
 * to re-point their account at somebody else's profile.
 */
export const organisationField = (
  tenantScoped = true,
  collectionSlug = ORGANISATIONS_SLUG,
): Field => ({
  name: 'organisation',
  type: 'relationship',
  relationTo: collectionSlug as CollectionSlug,
  index: true,
  access: {
    create: organisationAdminFieldAccess(false),
    update: organisationAdminFieldAccess(false),
  },
  validate: tenantScoped
    ? collectionSlug === ORGANISATIONS_SLUG
      ? organisationMatchesUserTenants
      : organisationMatchesUserTenantsWith(collectionSlug)
    : undefined,
  admin: {
    description: 'The organisation this employer belongs to.',
    position: 'sidebar',
  },
})

/**
 * What the user is inside their organisation. The first employer of an imported organisation is
 * its owner; PJ-29 builds invites and the owner/member permissions on top of this field.
 * Staff-only to change, like `organisation`.
 */
export const organisationRoleField = (): Field => ({
  name: 'organisationRole',
  type: 'select',
  options: [
    { label: 'Owner', value: 'owner' },
    { label: 'Member', value: 'member' },
  ],
  access: {
    create: organisationAdminFieldAccess(false),
    update: organisationAdminFieldAccess(false),
  },
  admin: {
    condition: (data) => Boolean(data?.organisation),
    description: 'Owners manage billing, the profile and members.',
    position: 'sidebar',
  },
})

/** Add `organisation` to a users collection, keeping everything else as it was. */
export const withOrganisationField = (
  collection: CollectionConfig,
  tenantScoped = true,
  collectionSlug = ORGANISATIONS_SLUG,
): CollectionConfig => {
  const hasField = collection.fields.some(
    (field) => 'name' in field && field.name === 'organisation',
  )
  if (hasField) return collection

  return {
    ...collection,
    fields: [
      ...collection.fields,
      organisationField(tenantScoped, collectionSlug),
      organisationRoleField(),
    ],
  }
}
