import {
  ValidationError,
  type Access,
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
 * TODO(PJ-16 follow-up): restrict a plan to job types/categories (`allowedTypes`,
 * `allowedCategories`), so "Volunteer listing" only applies to Voluntary jobs. The taxonomies
 * aren't on main yet (PR #35), so the restriction is enforced at checkout until then.
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

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted !== null && !tenantIDs.some((id) => String(id) === String(submitted))) {
      return false
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
 * A plan in a tenant with no currency, such as the aggregate hub, is rejected.
 */
export const planCurrencyFromTenant =
  ({ settingsSlug, tenantScoped, tenantsSlug }: TenantCurrencySource): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    let currency: unknown

    if (tenantScoped) {
      const tenantID = tenantIDOf(data?.tenant ?? originalDoc?.tenant)

      if (tenantID !== null) {
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
      }
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

const wholeNumber =
  (label: string, { min, optional = false }: { min: number; optional?: boolean }) =>
  (value: null | number | undefined): string | true => {
    if (value === null || value === undefined) return optional ? true : `${label} is required`
    return Number.isSafeInteger(value) && value >= min
      ? true
      : `${label} must be a whole number, ${min} or more`
  }

export const validatePlanPrice = (value: null | number | undefined): string | true =>
  isMinorUnits(value)
    ? true
    : 'Price must be a whole number of minor units, 0 or more (VUV has none, so 2500 is Vt 2,500)'

export const validatePlanKey = (value: null | string | undefined): string | true =>
  value && PLAN_KEY_PATTERN.test(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example regular-listing'

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
      validate: validatePlanKey,
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
          validate: validatePlanPrice,
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
          validate: wholeNumber('Listing duration', { min: 1 }),
          admin: { description: 'How long each listing stays live, in days.', step: 1 },
        },
        {
          name: 'jobCredits',
          type: 'number',
          defaultValue: 1,
          required: true,
          min: 1,
          validate: wholeNumber('Job credits', { min: 1 }),
          admin: { description: '1 for a single listing; more for a pack.', step: 1 },
        },
        {
          name: 'creditExpiryDays',
          type: 'number',
          min: 1,
          validate: wholeNumber('Credit expiry', { min: 1, optional: true }),
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
      validate: (value: null | number | undefined) =>
        value === null || value === undefined || Number.isSafeInteger(value)
          ? true
          : 'Sort order must be a whole number',
      admin: { description: 'Lower numbers are shown first.', position: 'sidebar', step: 1 },
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: { description: 'WordPress pricing-plan post id, for the import.', position: 'sidebar' },
    },
  ],
  hooks: {
    beforeChange: [planCurrencyFromTenant({ settingsSlug, tenantScoped, tenantsSlug })],
    beforeValidate: [uniquePlanKeyPerTenant(tenantScoped)],
  },
  indexes: tenantScoped ? [{ fields: ['tenant', 'key'], unique: true }] : [],
  labels: { plural: 'Plans', singular: 'Plan' },
  versions: false,
})
