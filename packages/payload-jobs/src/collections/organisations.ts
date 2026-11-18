import {
  ValidationError,
  type Access,
  type AccessResult,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type FieldAccess,
  type PayloadRequest,
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
import { getSiteKeyHeader, resolveSiteKey } from '../site-keys'
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
 * What a public site may see: an organisation is only published once an admin has approved it
 * and enabled its page (the legacy "listing request" flow, AUDIT.md).
 */
export const PUBLIC_ORGANISATION_FILTER: Where = {
  and: [{ approved: { equals: true } }, { pageEnabled: { equals: true } }],
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
 * user points at. `false` when neither applies.
 */
const organisationScopes = (
  user: MissionControlUser,
  ownOrganisation: null | number | string,
): AccessResult => {
  const scopes: Where[] = []
  const staffTenants = getUserTenantIDsByRole(user, ORGANISATION_EDITOR_ROLES)

  if (staffTenants.length > 0) scopes.push({ tenant: { in: staffTenants } })
  if (ownOrganisation !== null) scopes.push({ id: { equals: ownOrganisation } })

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
 * - Anonymous with a valid site key: the tenant's approved organisations with a live page
 *   (every tenant for an aggregate key). Without a key: nothing.
 * - Seekers: nothing they could not see on the site, and site reads carry a key.
 *
 * In multi-tenant mode the plugin also ANDs `tenant in <user's tenants>` onto a user's result.
 */
export const organisationReadAccess =
  (tenantScoped: boolean): Access =>
  async ({ req }) => {
    const user = userOf(req)

    if (!user) {
      // Site keys are a host collection; in single-tenant mode there is nothing to resolve, and
      // the public reads the collection through whatever the host exposes.
      if (!tenantScoped || !getSiteKeyHeader(req) || !hasCollection(req, 'site-keys')) return false

      const siteKey = await resolveSiteKey(req)
      if (!siteKey) return false
      if (siteKey.isAggregate) return PUBLIC_ORGANISATION_FILTER

      return {
        and: [{ tenant: { equals: siteKey.tenantID } }, PUBLIC_ORGANISATION_FILTER],
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

/** Approval, page visibility and billing terms are tenant-admin fields. */
export const organisationAdminFieldAccess: FieldAccess = ({ req }) => {
  const user = userOf(req)
  if (!user) return false
  if (isSuperAdmin(user)) return true

  return hasAnyTenantRole(user, ORGANISATION_ADMIN_ROLES)
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
  (tenantScoped: boolean, mediaSlug: null | string = 'media'): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data

    const tenantID = tenantIDOf(submitsTenant(data) ? data.tenant : originalDoc?.tenant)
    // The plugin's membership hook refuses a tenantless organisation.
    if (tenantID === null) return data

    const errors: { message: string; path: string }[] = []

    const relations: { label: string; path: string; relationTo: CollectionSlug }[] = [
      { label: 'areas of focus', path: 'areasOfFocus', relationTo: 'areas-of-focus' },
      { label: 'location', path: 'location', relationTo: 'locations' },
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

/**
 * An organisation belongs to exactly one tenant, and moving it would take its jobs, orders and
 * page with it. The multi-tenant plugin's tenant field lets any member of the collection point a
 * document at a tenant they belong to, so an employer in two tenants could move their own
 * organisation. Only tenant admins may re-assign one.
 */
export const organisationTenantIsStable =
  (tenantScoped: boolean): CollectionBeforeChangeHook =>
  ({ data, operation, originalDoc, req }) => {
    if (!tenantScoped || operation !== 'update' || !originalDoc) return data
    if (!submitsTenant(data)) return data

    const submitted = tenantIDOf(data.tenant)
    const stored = tenantIDOf(originalDoc.tenant)
    if (submitted === null || String(submitted) === String(stored)) return data

    const user = userOf(req)
    if (user && (isSuperAdmin(user) || hasAnyTenantRole(user, ORGANISATION_ADMIN_ROLES))) return data

    throw new ValidationError({
      collection: ORGANISATIONS_SLUG,
      errors: [{ message: 'Only a tenant admin can move an organisation', path: 'tenant' }],
      req,
    })
  }

const adminOnly = {
  create: organisationAdminFieldAccess,
  update: organisationAdminFieldAccess,
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

const profileFields = (mediaSlug: null | string): Field[] => [
  {
    name: 'name',
    type: 'text',
    required: true,
  },
  {
    name: 'slug',
    type: 'text',
    index: true,
    required: true,
    validate: validateOrganisationSlug,
    admin: {
      description: 'Used in the organisation page URL. Unique within the tenant.',
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
    name: 'areasOfFocus',
    type: 'relationship',
    relationTo: 'areas-of-focus',
    hasMany: true,
    admin: {
      description: 'From the tenant’s areas of focus. The directory filter uses these.',
    },
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
        relationTo: 'locations',
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
        name: 'pageEnabled',
        type: 'checkbox',
        defaultValue: false,
        access: adminOnly,
        admin: {
          description: 'Set by a tenant admin. The public page and directory entry go live.',
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
        access: adminOnly,
        admin: { description: 'Known customers pay by invoice instead of at checkout.' },
      },
      {
        name: 'billingEmail',
        type: 'email',
        access: adminOnly,
        admin: { description: 'Receives invoices. Falls back to the account email when empty.' },
      },
      {
        name: 'xeroContactCode',
        type: 'text',
        access: adminOnly,
        admin: { description: 'Xero contact for this organisation, used by invoice orders.' },
      },
    ],
  },
  {
    name: 'legacyId',
    type: 'number',
    index: true,
    access: adminOnly,
    admin: {
      description: 'WordPress user id of the legacy employer, for the import.',
      position: 'sidebar',
    },
  },
]

export type OrganisationsOptions = {
  /**
   * Slug of the host's upload collection for `logo` and `cover`. `null` drops the images,
   * for a config without uploads.
   */
  mediaSlug?: null | string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
}

/**
 * The organisation profiles employers edit in the admin and the public site reads.
 * Tenant-scoped: the multi-tenant plugin adds the `tenant` field and the tenant filter.
 */
export const organisationsCollection = ({
  mediaSlug = 'media',
  tenantScoped = true,
}: OrganisationsOptions = {}): CollectionConfig => ({
  slug: ORGANISATIONS_SLUG,
  access: {
    create: organisationCreateAccess(tenantScoped),
    delete: organisationDeleteAccess(tenantScoped),
    read: organisationReadAccess(tenantScoped),
    update: organisationUpdateAccess(tenantScoped),
  },
  admin: {
    defaultColumns: ['name', 'type', 'slug', 'approved', 'pageEnabled'],
    description:
      'Employer profiles. An employer edits their own; tenant admins approve them and set billing.',
    group: 'Job board',
    useAsTitle: 'name',
  },
  fields: profileFields(mediaSlug),
  hooks: {
    beforeChange: [
      organisationRelationsInTenant(tenantScoped, mediaSlug),
      organisationTenantIsStable(tenantScoped),
    ],
    beforeValidate: [uniqueSlugPerTenant(ORGANISATIONS_SLUG as CollectionSlug)],
  },
  // The unique index spans the tenant, so the same slug may exist on two tenants.
  indexes: tenantScoped ? [{ fields: ['tenant', 'slug'], unique: true }] : [],
  labels: { plural: 'Organisations', singular: 'Organisation' },
  versions: false,
})

/**
 * The relation an employer user gets to their organisation. Added to the users collection by
 * the plugin. Only staff may move a user to another organisation: an employer must not be able
 * to re-point their account at somebody else's profile.
 */
export const organisationField = (): Field => ({
  name: 'organisation',
  type: 'relationship',
  relationTo: ORGANISATIONS_SLUG,
  index: true,
  access: {
    create: organisationAdminFieldAccess,
    update: organisationAdminFieldAccess,
  },
  admin: {
    description: 'The organisation this employer belongs to.',
    position: 'sidebar',
  },
})

/** Add `organisation` to a users collection, keeping everything else as it was. */
export const withOrganisationField = (collection: CollectionConfig): CollectionConfig => {
  const hasField = collection.fields.some(
    (field) => 'name' in field && field.name === 'organisation',
  )
  if (hasField) return collection

  return { ...collection, fields: [...collection.fields, organisationField()] }
}
