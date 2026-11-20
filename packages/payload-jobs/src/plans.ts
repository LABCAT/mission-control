import {
  APIError,
  ValidationError,
  type Access,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type Where,
} from 'payload'

import {
  CATALOG_BUYER_ROLES,
  CATALOG_EDITOR_ROLES,
  CATALOG_KEY_PATTERN,
  catalogCreateAccess,
  catalogDeleteAccess,
  catalogReadAccess,
  catalogTaxFields,
  catalogUpdateAccess,
  currencyFromTenant,
  idsOf,
  optionalBoolean,
  resultingTenantID,
  taxRateKeyInTenant,
  uniqueKeyPerTenant,
  validateCatalogKey,
  validateName,
  validatePrice,
  validateTaxRateKey,
  wholeNumber,
  type Validator,
} from './catalog'
import { ADD_ONS_SLUG } from './add-ons'
import { PLAN_STATUSES, type PlanStatus } from './pricing'
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
 * - `includedAddOns` come with the plan at no charge, each for the plan's chosen duration or the
 *   add-on's own (Enhanced listing includes Enhanced). They must be in the plan's tenant.
 */

export const PLANS_SLUG = 'plans'

/** Staff roles that configure plans. */
export const PLAN_EDITOR_ROLES = CATALOG_EDITOR_ROLES

/** Tenant roles that may see the active plans, to buy one. */
export const PLAN_BUYER_ROLES = CATALOG_BUYER_ROLES

export const PLAN_KEY_PATTERN = CATALOG_KEY_PATTERN

const ACTIVE_ONLY: Where = { status: { equals: 'active' satisfies PlanStatus } }

/**
 * Read access (see `catalogReadAccess`): staff see every plan in their tenants, archived ones
 * included; employers and site keys see active plans only; seekers and keyless requests nothing.
 */
export const planReadAccess = (tenantScoped: boolean): Access =>
  catalogReadAccess({ onSale: ACTIVE_ONLY, tenantScoped })

/** Create needs a tenant the user edits; super admins skip the role check, not the tenant. */
export const planCreateAccess = catalogCreateAccess

/** Update is scoped to the user's editor tenants, and can't clear or move the tenant away. */
export const planUpdateAccess = catalogUpdateAccess

/** Only super admins delete. Everyone else archives, so a plan orders point at never disappears. */
export const planDeleteAccess = catalogDeleteAccess

type TenantCurrencySource = {
  settingsSlug: string
  tenantScoped: boolean
  tenantsSlug: string
}

/** Copy the tenant's currency on every save; reject a plan without a tenant or currency. */
export const planCurrencyFromTenant = (source: TenantCurrencySource): CollectionBeforeChangeHook =>
  currencyFromTenant({ ...source, noun: 'plan' })

/** A plan key is unique in its tenant, reported as a field error. */
export const uniquePlanKeyPerTenant = (tenantScoped: boolean): CollectionBeforeValidateHook =>
  uniqueKeyPerTenant(tenantScoped, 'plan')


/**
 * The allowed job types and categories, and the included add-ons, must belong to the plan's
 * tenant, and each add-on is included once. The multi-tenant plugin filters the admin pickers,
 * but a REST or local API write could still name another tenant's documents, so the server
 * checks.
 */
export const planRestrictionsInTenant =
  (tenantScoped: boolean): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    if (!tenantScoped) return data

    const tenantID = resultingTenantID(data, originalDoc)
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

    const included = (data?.includedAddOns ?? originalDoc?.includedAddOns) as unknown
    const includedIDs = idsOf(
      (Array.isArray(included) ? included : []).map((row: { addOn?: unknown }) => row?.addOn),
    )
    if (includedIDs.length > 0) {
      if (new Set(includedIDs.map(String)).size !== includedIDs.length) {
        errors.push({ message: 'Include each add-on once', path: 'includedAddOns' })
      } else {
        const { totalDocs } = await req.payload.count({
          collection: ADD_ONS_SLUG as CollectionSlug,
          overrideAccess: true,
          req,
          where: { and: [{ id: { in: includedIDs } }, { tenant: { equals: tenantID } }] },
        })
        if (totalDocs !== includedIDs.length) {
          errors.push({ message: 'Include only add-ons from this plan’s tenant', path: 'includedAddOns' })
        }
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

export const validatePlanPrice = validatePrice

export const validatePlanKey = validateCatalogKey('regular-listing')

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
  name: validateName,
  price: validatePlanPrice,
  sortOrder: wholeNumber('Sort order', { optional: true }),
  taxExempt: optionalBoolean('Tax exempt'),
  taxRateKey: validateTaxRateKey,
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
    ...catalogTaxFields(),
    {
      name: 'includedAddOns',
      type: 'array',
      admin: { description: 'Add-ons that come with this plan at no extra charge.' },
      fields: [
        {
          name: 'addOn',
          type: 'relationship',
          relationTo: ADD_ONS_SLUG,
          required: true,
        },
        {
          name: 'durationDays',
          type: 'number',
          min: 1,
          validate: wholeNumber('Included duration', { min: 1, optional: true }),
          admin: { description: 'Days the add-on lasts. Empty: the add-on’s own duration.', step: 1 },
        },
      ],
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
      taxRateKeyInTenant({ settingsSlug, tenantScoped, tenantsSlug }),
      planRestrictionsInTenant(tenantScoped),
    ],
    beforeValidate: [uniquePlanKeyPerTenant(tenantScoped)],
  },
  indexes: tenantScoped ? [{ fields: ['tenant', 'key'], unique: true }] : [],
  labels: { plural: 'Plans', singular: 'Plan' },
  versions: false,
})
