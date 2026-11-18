import {
  APIError,
  ValidationError,
  type Access,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type GlobalSlug,
  type PayloadRequest,
  type Where,
} from 'payload'

import {
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type TenantRole,
} from './access'
import { isMinorUnits } from './money'
import { PLAN_STATUSES, type PlanStatus } from './pricing'
import { getSiteKeyHeader, resolveSiteKey } from './site-keys'
import { TAXONOMY_SLUG_PATTERN } from './taxonomies'

/** The taxonomies a plan's restrictions point at (PJ-16). */
export const PLAN_JOB_TYPES_SLUG = 'job-types'
export const PLAN_JOB_CATEGORIES_SLUG = 'job-categories'

/**
 * Plans are what employers buy: a single listing, a pack of listings, a free volunteer
 * listing. They are data, not code: an admin adds or changes a plan in the admin, and the
 * pricing engine (`quote`) reads it.
 *
 * - A plan is never deleted by a tenant: it is archived. Archived plans can't be bought but
 *   stay readable to staff, and past orders keep their own snapshot of the plan (PJ-23).
 * - `price` is whole minor units of the tenant currency. `currency` is copied from the tenant
 *   on every save, so a price is never read in the wrong currency.
 *
 * - Restrictions are data too: `isVolunteer` limits a plan to voluntary jobs (job types
 *   flagged `isVolunteer`), and `allowedJobTypes` / `allowedJobCategories` relate it to the
 *   tenant's taxonomies (PJ-16); empty means any. `quote()` rejects a job the plan doesn't allow.
 * TODO(PJ-87): `includedAddOns` (add-on + duration) once the add-ons collection exists.
 * `quote()` already prices included add-ons.
 */

export const PLANS_SLUG = 'plans'

/** Staff roles that configure plans. */
export const PLAN_EDITOR_ROLES = ['tenant-admin', 'editor'] as const satisfies readonly TenantRole[]

/** Tenant roles that may see the active plans, to buy one. */
export const PLAN_BUYER_ROLES = ['employer'] as const satisfies readonly TenantRole[]

export const PLAN_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const ACTIVE_ONLY: Where = { status: { equals: 'active' satisfies PlanStatus } }

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
 * Read access.
 * - Super admins: every plan.
 * - Tenant admins and editors: every plan in their tenants, archived ones included.
 * - Employers: active plans in their tenants.
 * - Anonymous with a valid site key: active plans of the key's tenant (every tenant for the
 *   aggregate key). Without a key, or with an unknown one: nothing.
 *
 * In multi-tenant mode the plugin also ANDs `tenant in <user's tenants>` onto a user's result.
 */
export const planReadAccess =
  (tenantScoped: boolean): Access =>
  async ({ req }) => {
    const user = userOf(req)

    if (!user) {
      if (!tenantScoped || !getSiteKeyHeader(req) || !hasCollection(req, 'site-keys')) return false

      const siteKey = await resolveSiteKey(req)
      if (!siteKey) return false
      if (siteKey.isAggregate) return ACTIVE_ONLY

      return { and: [{ tenant: { equals: siteKey.tenantID } }, ACTIVE_ONLY] }
    }

    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, PLAN_EDITOR_ROLES)) return true
      return hasAnyTenantRole(user, PLAN_BUYER_ROLES) ? ACTIVE_ONLY : false
    }

    const editorTenants = getUserTenantIDsByRole(user, PLAN_EDITOR_ROLES)
    const buyerTenants = getUserTenantIDsByRole(user, PLAN_BUYER_ROLES)
    const scopes: Where[] = []

    if (editorTenants.length > 0) scopes.push({ tenant: { in: editorTenants } })
    if (buyerTenants.length > 0) {
      scopes.push({ and: [{ tenant: { in: buyerTenants } }, ACTIVE_ONLY] })
    }

    if (scopes.length === 0) return false
    return scopes.length === 1 ? scopes[0] : { or: scopes }
  }

/**
 * Create needs the tenant in the submitted data, because a `where` result doesn't filter
 * create data. Super admins skip the role check but not the tenant requirement.
 */
export const planCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (!tenantScoped) return isSuperAdmin(user) || hasAnyTenantRole(user, PLAN_EDITOR_ROLES)

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    if (isSuperAdmin(user)) return true

    return getUserTenantIDsByRole(user, PLAN_EDITOR_ROLES).some(
      (id) => String(id) === String(submitted),
    )
  }

/** Update is scoped to the tenants where the user is a tenant-admin or editor. */
export const planUpdateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (!tenantScoped) return hasAnyTenantRole(user, PLAN_EDITOR_ROLES)

    const tenantIDs = getUserTenantIDsByRole(user, PLAN_EDITOR_ROLES)
    if (tenantIDs.length === 0) return false

    // An omitted tenant keeps the stored one. A submitted one, including an explicit null that
    // would orphan the plan, must be a tenant the user edits.
    if (submitsTenant(data)) {
      const submitted = tenantIDOf((data as { tenant?: unknown }).tenant)
      if (submitted === null || !tenantIDs.some((id) => String(id) === String(submitted))) {
        return false
      }
    }

    return { tenant: { in: tenantIDs } }
  }

/**
 * Only super admins delete, for clean-up. Everyone else archives, so a plan that orders point
 * at never disappears.
 */
export const planDeleteAccess: Access = ({ req }) => isSuperAdmin(userOf(req))

type TenantCurrencySource = {
  settingsSlug: string
  tenantScoped: boolean
  tenantsSlug: string
}

/**
 * Copy the currency from the tenant (or the single-tenant settings global) on every save.
 * A plan with no tenant after the save, or in a tenant with no currency such as the aggregate
 * hub, is rejected. This also stops a super admin, whom access lets through, from orphaning a
 * plan with `tenant: null`.
 */
export const planCurrencyFromTenant =
  ({ settingsSlug, tenantScoped, tenantsSlug }: TenantCurrencySource): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    let currency: unknown

    if (tenantScoped) {
      // The resulting tenant: the submitted value when the key is present (null included),
      // otherwise the stored one.
      const tenantID = tenantIDOf(submitsTenant(data) ? data.tenant : originalDoc?.tenant)

      if (tenantID === null) {
        throw new ValidationError({
          collection: collection.slug,
          errors: [{ message: 'A plan must belong to a tenant', path: 'tenant' }],
          req,
        })
      }

      const tenant = await req.payload.findByID({
        collection: tenantsSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: tenantID,
        overrideAccess: true,
        req,
        select: { currency: true },
      })
      currency = (tenant as null | { currency?: unknown })?.currency
    } else {
      const settings = await req.payload.findGlobal({
        depth: 0,
        overrideAccess: true,
        req,
        slug: settingsSlug as GlobalSlug,
      })
      currency = (settings as { currency?: unknown })?.currency
    }

    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [
          {
            message: 'Set a currency on the tenant before adding plans',
            path: 'currency',
          },
        ],
        req,
      })
    }

    return { ...data, currency }
  }

/**
 * Reject a key another plan in the same tenant already uses, as a field error rather than a
 * raw unique-index failure. The index still guards against concurrent writes.
 */
export const uniquePlanKeyPerTenant =
  (tenantScoped: boolean): CollectionBeforeValidateHook =>
  async ({ collection, data, originalDoc, req }) => {
    const key = typeof data?.key === 'string' ? data.key : undefined
    if (!key || !tenantScoped) return data

    const tenantID = tenantIDOf(data?.tenant ?? originalDoc?.tenant)
    if (tenantID === null) return data

    const { docs } = await req.payload.find({
      collection: collection.slug,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ key: { equals: key } }, { tenant: { equals: tenantID } }] },
    })

    const selfID = originalDoc?.id
    if (docs.some((doc) => selfID === undefined || String(doc.id) !== String(selfID))) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: `Key "${key}" is already used by another plan`, path: 'key' }],
        req,
      })
    }

    return data
  }

type Validator<T> = (value: T) => string | true

const idsOf = (value: unknown): (number | string)[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => tenantIDOf(entry))
    .filter((id): id is number | string => id !== null)

/**
 * The allowed job types and categories must belong to the plan's tenant. The multi-tenant
 * plugin filters the admin pickers, but a REST or local API write could still name another
 * tenant's taxonomy, so the server checks.
 */
export const planRestrictionsInTenant =
  (tenantScoped: boolean): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data

    const tenantID = tenantIDOf(submitsTenant(data) ? data.tenant : originalDoc?.tenant)
    if (tenantID === null) return data // planCurrencyFromTenant rejects this.

    const errors: { message: string; path: string }[] = []

    for (const [path, relationTo] of [
      ['allowedJobTypes', PLAN_JOB_TYPES_SLUG],
      ['allowedJobCategories', PLAN_JOB_CATEGORIES_SLUG],
    ] as const) {
      const ids = idsOf(data?.[path] ?? originalDoc?.[path])
      if (ids.length === 0) continue

      const { totalDocs } = await req.payload.count({
        collection: relationTo as CollectionSlug,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: ids } }, { tenant: { equals: tenantID } }] },
      })
      if (totalDocs !== new Set(ids.map(String)).size) {
        errors.push({ message: 'Pick only taxonomies from this plan’s tenant', path })
      }
    }

    if (errors.length > 0) throw new ValidationError({ collection: collection.slug, errors, req })
    return data
  }

/**
 * Refuse to delete a job type or category that a plan is restricted to. The relationship rows
 * cascade on delete, so without this a plan limited to that type would quietly become a plan for
 * any job. Archived plans count too: an admin may restore them.
 *
 * Deleting a whole tenant still works: the multi-tenant plugin deletes the tenant's documents
 * after the tenant row is gone, when the plans' `tenant` is already null, so those plans don't
 * count and both the plans and the taxonomies are cleaned up.
 */
export const preventDeletingPlanRestriction =
  (
    field: 'allowedJobCategories' | 'allowedJobTypes',
    { tenantScoped = true }: { tenantScoped?: boolean } = {},
  ): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const uses: Where = { [field]: { in: [id] } }
    const { docs, totalDocs } = await req.payload.find({
      collection: PLANS_SLUG as CollectionSlug,
      depth: 0,
      limit: 5,
      overrideAccess: true,
      req,
      where: tenantScoped ? { and: [uses, { tenant: { exists: true } }] } : uses,
    })
    if (totalDocs === 0) return

    const names = docs.map((doc) => `"${String((doc as { name?: unknown }).name ?? doc.id)}"`)
    throw new APIError(
      `Plans are restricted to this ${field === 'allowedJobTypes' ? 'job type' : 'job category'}: ` +
        `${names.join(', ')}${totalDocs > names.length ? ' and more' : ''}. ` +
        'Remove it from those plans first.',
      409,
    )
  }

/** Add the delete guard to the taxonomies plans point at. Other collections pass through. */
export const withPlanRestrictionGuards = (
  collections: CollectionConfig[],
  { tenantScoped = true }: { tenantScoped?: boolean } = {},
): CollectionConfig[] =>
  collections.map((collection) => {
    const field =
      collection.slug === PLAN_JOB_TYPES_SLUG
        ? 'allowedJobTypes'
        : collection.slug === PLAN_JOB_CATEGORIES_SLUG
          ? 'allowedJobCategories'
          : null
    if (!field) return collection

    return {
      ...collection,
      hooks: {
        ...collection.hooks,
        beforeDelete: [
          ...(collection.hooks?.beforeDelete ?? []),
          preventDeletingPlanRestriction(field, { tenantScoped }),
        ],
      },
    }
  })

const wholeNumber =
  (
    label: string,
    { min, optional = false }: { min?: number; optional?: boolean },
  ): Validator<null | number | undefined> =>
  (value) => {
    if (value === null || value === undefined) return optional ? true : `${label} is required`
    if (!Number.isSafeInteger(value)) return `${label} must be a whole number`
    return min === undefined || value >= min ? true : `${label} must be a whole number, ${min} or more`
  }

export const validatePlanPrice: Validator<null | number | undefined> = (value) =>
  isMinorUnits(value)
    ? true
    : 'Price must be a whole number of minor units, 0 or more (VUV has none, so 2500 is Vt 2,500)'

export const validatePlanKey: Validator<null | string | undefined> = (value) =>
  value && PLAN_KEY_PATTERN.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example regular-listing'

const validatePlanName: Validator<null | string | undefined> = (value) =>
  typeof value === 'string' && value.trim() ? true : 'Name is required'

/** Taxonomy slugs, as plan seeds name the allowed types and categories. */
export const validateTaxonomySlugs =
  (label: string): Validator<null | readonly string[] | undefined> =>
  (value) => {
    if (value === null || value === undefined) return true
    if (!Array.isArray(value)) return `${label} must be a list of slugs`
    const bad = value.find((slug) => typeof slug !== 'string' || !TAXONOMY_SLUG_PATTERN.test(slug))
    if (bad !== undefined) return `${label}: "${String(bad)}" is not a slug, e.g. full-time`
    return new Set(value).size === value.length ? true : `${label} lists a slug twice`
  }

const optionalBoolean =
  (label: string): Validator<unknown> =>
  (value) =>
    value === null || value === undefined || typeof value === 'boolean' ? true : `${label} must be true or false`

/**
 * One validator per plan field. The collection fields and the seed (`planSeedProblems`) both use
 * these, so seed data is checked by exactly the rules a save would apply.
 */
export const planFieldValidators = {
  acceptsCredits: optionalBoolean('Accepts credits'),
  creditExpiryDays: wholeNumber('Credit expiry', { min: 1, optional: true }),
  durationDays: wholeNumber('Listing duration', { min: 1 }),
  isVolunteer: optionalBoolean('Volunteer only'),
  jobCredits: wholeNumber('Job credits', { min: 1 }),
  key: validatePlanKey,
  legacyId: wholeNumber('Legacy id', { min: 1, optional: true }),
  name: validatePlanName,
  price: validatePlanPrice,
  sortOrder: wholeNumber('Sort order', { optional: true }),
} as const

export type PlanCollectionOptions = {
  /** Single-tenant settings global that holds the currency. */
  settingsSlug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
  tenantsSlug?: string
}

export const planCollection = ({
  settingsSlug = 'job-board-settings',
  tenantScoped = true,
  tenantsSlug = 'tenants',
}: PlanCollectionOptions = {}): CollectionConfig => ({
  slug: PLANS_SLUG,
  access: {
    create: planCreateAccess(tenantScoped),
    delete: planDeleteAccess,
    read: planReadAccess(tenantScoped),
    update: planUpdateAccess(tenantScoped),
  },
  admin: {
    defaultColumns: ['name', 'price', 'currency', 'durationDays', 'jobCredits', 'status', 'sortOrder'],
    description:
      'What employers buy. Archive a plan to stop selling it; past orders keep what they bought.',
    group: 'Job board',
    useAsTitle: 'name',
  },
  defaultSort: 'sortOrder',
  fields: [
    {
      name: 'name',
      type: 'text',
      localized: true,
      required: true,
    },
    {
      name: 'key',
      type: 'text',
      index: true,
      required: true,
      unique: !tenantScoped,
      validate: planFieldValidators.key,
      admin: {
        description: 'Stable identifier used by seeds and imports, e.g. regular-listing. Unique in the tenant.',
      },
    },
    {
      name: 'description',
      type: 'textarea',
      localized: true,
    },
    {
      type: 'row',
      fields: [
        {
          name: 'price',
          type: 'number',
          required: true,
          min: 0,
          validate: planFieldValidators.price,
          admin: {
            description: 'Whole minor units of the tenant currency: 2500 is Vt 2,500, or $25.00 in NZD.',
            step: 1,
          },
        },
        {
          name: 'currency',
          type: 'text',
          admin: {
            description: 'Copied from the tenant when the plan is saved.',
            readOnly: true,
          },
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'durationDays',
          type: 'number',
          required: true,
          min: 1,
          validate: planFieldValidators.durationDays,
          admin: { description: 'How long each listing stays live, in days.', step: 1 },
        },
        {
          name: 'jobCredits',
          type: 'number',
          defaultValue: 1,
          required: true,
          min: 1,
          validate: planFieldValidators.jobCredits,
          admin: { description: '1 for a single listing; more for a pack.', step: 1 },
        },
        {
          name: 'creditExpiryDays',
          type: 'number',
          min: 1,
          validate: planFieldValidators.creditExpiryDays,
          admin: {
            description: 'Days until unused credits from this plan expire. Empty: they never expire.',
            step: 1,
          },
        },
      ],
    },
    {
      name: 'acceptsCredits',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description:
          'A job credit from a pack can pay for this plan. Only applies to single-listing plans.',
      },
    },
    {
      type: 'collapsible',
      label: 'Restrictions',
      admin: {
        description: 'Which jobs this plan can be used for. Leave everything empty for any job.',
      },
      fields: [
        {
          name: 'isVolunteer',
          type: 'checkbox',
          defaultValue: false,
          admin: { description: 'Only for voluntary jobs (a job type marked as volunteer).' },
        },
        {
          name: 'allowedJobTypes',
          type: 'relationship',
          relationTo: PLAN_JOB_TYPES_SLUG,
          hasMany: true,
          admin: { description: 'Only jobs of these types. Empty: any type.' },
        },
        {
          name: 'allowedJobCategories',
          type: 'relationship',
          relationTo: PLAN_JOB_CATEGORIES_SLUG,
          hasMany: true,
          admin: {
            description: 'Only jobs whose every category is listed here. Empty: any category.',
          },
        },
      ],
    },
    {
      name: 'status',
      type: 'select',
      defaultValue: 'active',
      index: true,
      required: true,
      options: PLAN_STATUSES.map((value) => ({
        label: value === 'active' ? 'Active' : 'Archived',
        value,
      })),
      admin: {
        description: 'Archived plans can no longer be bought. Past orders are not affected.',
        position: 'sidebar',
      },
    },
    {
      name: 'sortOrder',
      type: 'number',
      defaultValue: 0,
      validate: planFieldValidators.sortOrder,
      admin: { description: 'Lower numbers are shown first.', position: 'sidebar', step: 1 },
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      validate: planFieldValidators.legacyId,
      admin: { description: 'WordPress pricing-plan post id, for the import.', position: 'sidebar' },
    },
  ],
  hooks: {
    beforeChange: [
      planCurrencyFromTenant({ settingsSlug, tenantScoped, tenantsSlug }),
      planRestrictionsInTenant(tenantScoped),
    ],
    beforeValidate: [uniquePlanKeyPerTenant(tenantScoped)],
  },
  indexes: tenantScoped ? [{ fields: ['tenant', 'key'], unique: true }] : [],
  labels: { plural: 'Plans', singular: 'Plan' },
  versions: false,
})
