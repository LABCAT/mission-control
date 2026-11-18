import {
  APIError,
  ValidationError,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type CollectionSlug,
  type Where,
} from 'payload'

import {
  catalogCreateAccess,
  catalogDeleteAccess,
  catalogReadAccess,
  catalogUpdateAccess,
  currencyFromTenant,
  idsOf,
  optionalBoolean,
  resultingTenantID,
  uniqueKeyPerTenant,
  validateCatalogKey,
  validateName,
  validatePrice,
  wholeNumber,
} from './catalog'

/**
 * Add-ons are paid extras on a listing, such as featuring it. Like plans they are data: an
 * admin adds, prices and retires them, and the pricing engine (`quote`) reads them.
 *
 * - `placement` is the one thing code understands: where the add-on shows the job
 *   (`ADD_ON_PLACEMENTS`). Jobs store their active placements with an expiry each
 *   (see `placements.ts`), and listings sort and badge by them.
 * - `grants` gives other add-ons for free, each for its own duration (Premium gives 30 days
 *   of Enhanced). Grants stay in the add-on's tenant and never form a cycle.
 * - An add-on is retired with `active: false`, never deleted by a tenant: plans that include
 *   it, and grants that give it, keep honouring it.
 */

export const ADD_ONS_SLUG = 'add-ons'

/** The plans collection (plans.ts imports this module, so the slug is repeated here). */
const PLANS_SLUG = 'plans'

/** Where an add-on shows a job. Listings know how to sort and badge each one. */
export const ADD_ON_PLACEMENTS = ['featured-in-listings', 'featured-in-category'] as const
export type AddOnPlacement = (typeof ADD_ON_PLACEMENTS)[number]

export const ADD_ON_PLACEMENT_LABELS: Record<AddOnPlacement, string> = {
  'featured-in-category': 'Featured in its category',
  'featured-in-listings': 'Featured in listings',
}

export const isAddOnPlacement = (value: unknown): value is AddOnPlacement =>
  typeof value === 'string' && (ADD_ON_PLACEMENTS as readonly string[]).includes(value)

const ON_SALE: Where = { active: { equals: true } }

/** Grants can chain (A grants B grants C); this bounds the walk when checking for cycles. */
const MAX_GRANT_DEPTH = 32

type GrantRow = { addOn?: unknown; durationDays?: unknown }

const grantIDsOf = (grants: unknown): (number | string)[] =>
  idsOf((Array.isArray(grants) ? (grants as GrantRow[]) : []).map((grant) => grant?.addOn))

/**
 * Granted add-ons must be in this add-on's tenant, must not be the add-on itself, and must not
 * lead back to it through their own grants. The admin picker is filtered by tenant, but a REST
 * or local API write could still name anything, so the server checks.
 */
export const addOnGrantsValid =
  (tenantScoped: boolean): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    const grants = data?.grants ?? originalDoc?.grants
    const granted = grantIDsOf(grants)
    if (granted.length === 0) return data

    const fail = (message: string): never => {
      throw new ValidationError({ collection: collection.slug, errors: [{ message, path: 'grants' }], req })
    }

    const selfID = originalDoc?.id
    if (selfID !== undefined && granted.some((id) => String(id) === String(selfID))) {
      fail('An add-on can’t grant itself')
    }
    if (new Set(granted.map(String)).size !== granted.length) fail('Each add-on can be granted once')

    const tenantID = resultingTenantID(data, originalDoc)
    if (tenantScoped && tenantID !== null) {
      const { totalDocs } = await req.payload.count({
        collection: collection.slug,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: granted } }, { tenant: { equals: tenantID } }] },
      })
      if (totalDocs !== granted.length) fail('Grant only add-ons from this add-on’s tenant')
    }

    // A new add-on can't be part of a cycle yet: nothing grants it.
    if (selfID === undefined) return data

    const seen = new Set<string>()
    let frontier = granted.map(String)
    for (let depth = 0; frontier.length > 0 && depth < MAX_GRANT_DEPTH; depth++) {
      const { docs } = await req.payload.find({
        collection: collection.slug as CollectionSlug,
        depth: 0,
        limit: frontier.length,
        overrideAccess: true,
        pagination: false,
        req,
        where: { id: { in: frontier } },
      })
      frontier.forEach((id) => seen.add(id))
      const next = docs.flatMap((doc) => grantIDsOf((doc as { grants?: unknown }).grants).map(String))
      if (next.includes(String(selfID))) fail('These grants would lead back to this add-on')
      frontier = [...new Set(next)].filter((id) => !seen.has(id))
    }

    return data
  }

/**
 * Refuse to delete an add-on that a plan includes or another add-on grants. Their relationship
 * rows would cascade away and quietly take the extra out of what those plans sell. Retire it
 * with `active: false` instead.
 *
 * Deleting a whole tenant still works: by the time its documents are cleaned up their `tenant`
 * is null, so they don't count.
 */
export const preventDeletingAddOnInUse = ({
  tenantScoped = true,
}: { tenantScoped?: boolean } = {}): CollectionBeforeDeleteHook => {
  const inTenant = (where: Where): Where =>
    tenantScoped ? { and: [where, { tenant: { exists: true } }] } : where

  return async ({ collection, id, req }) => {
    const uses: string[] = []
    const collections = req.payload.collections as Record<string, unknown>

    if (collections[PLANS_SLUG]) {
      const { docs, totalDocs } = await req.payload.find({
        collection: PLANS_SLUG as CollectionSlug,
        depth: 0,
        limit: 3,
        overrideAccess: true,
        req,
        where: inTenant({ 'includedAddOns.addOn': { in: [id] } }),
      })
      if (totalDocs > 0) {
        uses.push(`plans ${docs.map((doc) => `"${String((doc as { name?: unknown }).name ?? doc.id)}"`).join(', ')}`)
      }
    }

    const { docs, totalDocs } = await req.payload.find({
      collection: collection.slug as CollectionSlug,
      depth: 0,
      limit: 3,
      overrideAccess: true,
      req,
      where: inTenant({ 'grants.addOn': { in: [id] } }),
    })
    if (totalDocs > 0) {
      uses.push(`add-ons ${docs.map((doc) => `"${String((doc as { name?: unknown }).name ?? doc.id)}"`).join(', ')}`)
    }

    if (uses.length > 0) {
      throw new APIError(
        `This add-on is still used by ${uses.join(' and ')}. Mark it inactive instead, or remove it from those first.`,
        409,
      )
    }
  }
}

/**
 * One validator per add-on field. The collection and the seed (`addOnSeedProblems`) both use
 * these, so seed data is checked by the rules a save would apply.
 */
export const addOnFieldValidators = {
  active: optionalBoolean('Active'),
  durationDays: wholeNumber('Duration', { min: 1 }),
  key: validateCatalogKey('enhanced'),
  legacyId: wholeNumber('Legacy id', { min: 1, optional: true }),
  name: validateName,
  placement: (value: unknown): string | true =>
    isAddOnPlacement(value) ? true : `Placement must be one of ${ADD_ON_PLACEMENTS.join(', ')}`,
  price: validatePrice,
  sortOrder: wholeNumber('Sort order', { optional: true }),
} as const

export type AddOnCollectionOptions = {
  /** Single-tenant settings global that holds the currency. */
  settingsSlug?: string
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
  tenantsSlug?: string
}

export const addOnCollection = ({
  settingsSlug = 'job-board-settings',
  tenantScoped = true,
  tenantsSlug = 'tenants',
}: AddOnCollectionOptions = {}): CollectionConfig => ({
  slug: ADD_ONS_SLUG,
  access: {
    create: catalogCreateAccess(tenantScoped),
    delete: catalogDeleteAccess,
    read: catalogReadAccess({ onSale: ON_SALE, tenantScoped }),
    update: catalogUpdateAccess(tenantScoped),
  },
  admin: {
    defaultColumns: ['name', 'price', 'currency', 'durationDays', 'placement', 'active', 'sortOrder'],
    description:
      'Extras on a listing, such as featuring it. Mark one inactive to stop selling it; past orders keep what they bought.',
    group: 'Job board',
    useAsTitle: 'name',
  },
  defaultSort: 'sortOrder',
  fields: [
    { name: 'name', type: 'text', localized: true, required: true },
    {
      name: 'key',
      type: 'text',
      index: true,
      required: true,
      unique: !tenantScoped,
      validate: addOnFieldValidators.key,
      admin: { description: 'Stable identifier used by seeds and imports, e.g. enhanced. Unique in the tenant.' },
    },
    { name: 'description', type: 'textarea', localized: true },
    {
      type: 'row',
      fields: [
        {
          name: 'price',
          type: 'number',
          required: true,
          min: 0,
          validate: addOnFieldValidators.price,
          admin: {
            description: 'Whole minor units of the tenant currency: 2500 is Vt 2,500, or $25.00 in NZD.',
            step: 1,
          },
        },
        {
          name: 'currency',
          type: 'text',
          admin: { description: 'Copied from the tenant when the add-on is saved.', readOnly: true },
        },
        {
          name: 'durationDays',
          type: 'number',
          required: true,
          min: 1,
          validate: addOnFieldValidators.durationDays,
          admin: { description: 'How long the add-on lasts on a job, in days.', step: 1 },
        },
      ],
    },
    {
      name: 'placement',
      type: 'select',
      required: true,
      options: ADD_ON_PLACEMENTS.map((value) => ({ label: ADD_ON_PLACEMENT_LABELS[value], value })),
      admin: { description: 'Where the add-on shows the job.' },
    },
    {
      name: 'grants',
      type: 'array',
      admin: {
        description: 'Other add-ons this one gives for free, each for its own duration.',
      },
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
          required: true,
          min: 1,
          validate: wholeNumber('Granted duration', { min: 1 }),
          admin: { step: 1 },
        },
      ],
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      index: true,
      admin: {
        description: 'Inactive add-ons can no longer be bought. Plans and grants that give them still do.',
        position: 'sidebar',
      },
    },
    {
      name: 'sortOrder',
      type: 'number',
      defaultValue: 0,
      validate: addOnFieldValidators.sortOrder,
      admin: { description: 'Lower numbers are shown first.', position: 'sidebar', step: 1 },
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      validate: addOnFieldValidators.legacyId,
      admin: { description: 'WordPress id, for the import, when there is one.', position: 'sidebar' },
    },
    {
      name: 'legacyKey',
      type: 'text',
      index: true,
      admin: {
        description: 'The JobRoller job meta key this replaces, e.g. _jr_featured-listings, for the import.',
        position: 'sidebar',
      },
    },
  ],
  hooks: {
    beforeChange: [
      currencyFromTenant({ noun: 'add-on', settingsSlug, tenantScoped, tenantsSlug }),
      addOnGrantsValid(tenantScoped),
    ],
    beforeDelete: [preventDeletingAddOnInUse({ tenantScoped })],
    beforeValidate: [uniqueKeyPerTenant(tenantScoped, 'add-on')],
  },
  indexes: tenantScoped ? [{ fields: ['tenant', 'key'], unique: true }] : [],
  labels: { plural: 'Add-ons', singular: 'Add-on' },
  versions: false,
})
