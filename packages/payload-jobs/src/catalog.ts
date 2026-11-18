import {
  ValidationError,
  type Access,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionSlug,
  type Field,
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
import { getSiteKeyHeader, resolveSiteKey } from './site-keys'

/**
 * What plans and add-ons share: they are a tenant's sellable catalog. Staff configure it,
 * employers and public sites see only what is on sale, and nobody but a super admin deletes
 * from it (things are retired instead, so past orders keep pointing at them).
 */

/** Staff roles that configure the catalog. */
export const CATALOG_EDITOR_ROLES = ['tenant-admin', 'editor'] as const satisfies readonly TenantRole[]

/** Tenant roles that may see what is on sale, to buy it. */
export const CATALOG_BUYER_ROLES = ['employer'] as const satisfies readonly TenantRole[]

/** Stable per-tenant keys: lowercase letters, numbers and single hyphens. */
export const CATALOG_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const tenantIDOf = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return (tenant as { id?: number | string }).id ?? null
  return tenant as number | string
}

/** True when the write data carries a `tenant` key at all, even `null` or `undefined`. */
export const submitsTenant = (data: unknown): boolean =>
  typeof data === 'object' && data !== null && Object.prototype.hasOwnProperty.call(data, 'tenant')

/** The tenant a save ends with: the submitted value when present (null included), else the stored. */
export const resultingTenantID = (
  data: Record<string, unknown> | undefined,
  originalDoc: Record<string, unknown> | undefined,
): null | number | string => tenantIDOf(submitsTenant(data) ? data?.tenant : originalDoc?.tenant)

/** Ids from a relationship value: ids, populated documents, or a mix. */
export const idsOf = (value: unknown): (number | string)[] =>
  (Array.isArray(value) ? value : [])
    .map((entry) => tenantIDOf(entry))
    .filter((id): id is number | string => id !== null)

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const hasCollection = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload?.collections as Record<string, unknown> | undefined)?.[slug])

type CatalogAccessOptions = {
  /** What "on sale" means for this collection, e.g. `{ status: { equals: 'active' } }`. */
  onSale: Where
  tenantScoped: boolean
}

/**
 * Read access.
 * - Super admins: everything.
 * - Tenant admins and editors: everything in their tenants, retired items included.
 * - Employers: what is on sale in their tenants.
 * - Anonymous with a valid site key: what is on sale in the key's tenant (every tenant for the
 *   aggregate key). Without a key, or with an unknown one: nothing.
 *
 * In multi-tenant mode the plugin also ANDs `tenant in <user's tenants>` onto a user's result.
 */
export const catalogReadAccess =
  ({ onSale, tenantScoped }: CatalogAccessOptions): Access =>
  async ({ req }) => {
    const user = userOf(req)

    if (!user) {
      if (!tenantScoped || !getSiteKeyHeader(req) || !hasCollection(req, 'site-keys')) return false

      const siteKey = await resolveSiteKey(req)
      if (!siteKey) return false
      if (siteKey.isAggregate) return onSale

      return { and: [{ tenant: { equals: siteKey.tenantID } }, onSale] }
    }

    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    if (!tenantScoped) {
      if (hasAnyTenantRole(user, CATALOG_EDITOR_ROLES)) return true
      return hasAnyTenantRole(user, CATALOG_BUYER_ROLES) ? onSale : false
    }

    const editorTenants = getUserTenantIDsByRole(user, CATALOG_EDITOR_ROLES)
    const buyerTenants = getUserTenantIDsByRole(user, CATALOG_BUYER_ROLES)
    const scopes: Where[] = []

    if (editorTenants.length > 0) scopes.push({ tenant: { in: editorTenants } })
    if (buyerTenants.length > 0) scopes.push({ and: [{ tenant: { in: buyerTenants } }, onSale] })

    if (scopes.length === 0) return false
    return scopes.length === 1 ? scopes[0] : { or: scopes }
  }

/**
 * Create needs the tenant in the submitted data, because a `where` result doesn't filter
 * create data. Super admins skip the role check but not the tenant requirement.
 */
export const catalogCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (!tenantScoped) return isSuperAdmin(user) || hasAnyTenantRole(user, CATALOG_EDITOR_ROLES)

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    if (isSuperAdmin(user)) return true

    return getUserTenantIDsByRole(user, CATALOG_EDITOR_ROLES).some(
      (id) => String(id) === String(submitted),
    )
  }

/** Update is scoped to the tenants where the user is a tenant-admin or editor. */
export const catalogUpdateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (!tenantScoped) return hasAnyTenantRole(user, CATALOG_EDITOR_ROLES)

    const tenantIDs = getUserTenantIDsByRole(user, CATALOG_EDITOR_ROLES)
    if (tenantIDs.length === 0) return false

    // An omitted tenant keeps the stored one. A submitted one, including an explicit null that
    // would orphan the document, must be a tenant the user edits.
    if (submitsTenant(data)) {
      const submitted = tenantIDOf((data as { tenant?: unknown }).tenant)
      if (submitted === null || !tenantIDs.some((id) => String(id) === String(submitted))) {
        return false
      }
    }

    return { tenant: { in: tenantIDs } }
  }

/** Only super admins delete, for clean-up. Everyone else retires the item instead. */
export const catalogDeleteAccess: Access = ({ req }) => isSuperAdmin(userOf(req))

export type TenantCurrencySource = {
  /** What the collection holds, for messages: "plan", "add-on". */
  noun: string
  settingsSlug: string
  tenantScoped: boolean
  tenantsSlug: string
}

/**
 * Copy the currency from the tenant (or the single-tenant settings global) on every save.
 * A document with no tenant after the save, or in a tenant with no currency such as the
 * aggregate hub, is rejected. This also stops a super admin, whom access lets through, from
 * orphaning a document with `tenant: null`.
 */
export const currencyFromTenant =
  ({ noun, settingsSlug, tenantScoped, tenantsSlug }: TenantCurrencySource): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    let currency: unknown

    if (tenantScoped) {
      const tenantID = resultingTenantID(data, originalDoc)

      if (tenantID === null) {
        throw new ValidationError({
          collection: collection.slug,
          errors: [{ message: `A ${noun} must belong to a tenant`, path: 'tenant' }],
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
        errors: [{ message: `Set a currency on the tenant before adding ${noun}s`, path: 'currency' }],
        req,
      })
    }

    return { ...data, currency }
  }

/**
 * Reject a key another document in the same tenant already uses, as a field error rather
 * than a raw unique-index failure. The index still guards against concurrent writes.
 */
export const uniqueKeyPerTenant =
  (tenantScoped: boolean, noun: string): CollectionBeforeValidateHook =>
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
        errors: [{ message: `Key "${key}" is already used by another ${noun}`, path: 'key' }],
        req,
      })
    }

    return data
  }

/**
 * A plan or add-on that names a tax rate must name one of its tenant's rates. Without a name it
 * uses the tenant's default rate; `taxExempt` items are never taxed.
 */
export const taxRateKeyInTenant =
  ({ settingsSlug, tenantScoped, tenantsSlug }: Omit<TenantCurrencySource, 'noun'>): CollectionBeforeChangeHook =>
  async ({ collection, data, originalDoc, req }) => {
    const key = (data && 'taxRateKey' in data ? data.taxRateKey : originalDoc?.taxRateKey) as unknown
    if (key === null || key === undefined || key === '') return data

    let source: unknown
    if (tenantScoped) {
      const tenantID = resultingTenantID(data, originalDoc)
      if (tenantID === null) return data // currencyFromTenant rejects this.
      source = await req.payload.findByID({
        collection: tenantsSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: tenantID,
        overrideAccess: true,
        req,
      })
    } else {
      source = await req.payload.findGlobal({ depth: 0, overrideAccess: true, req, slug: settingsSlug as GlobalSlug })
    }

    const rates = (source as null | { tax?: { rates?: { key?: unknown }[] | null } | null })?.tax?.rates ?? []
    if (!rates.some((rate) => rate?.key === key)) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: `"${String(key)}" is not one of the tenant’s tax rates`, path: 'taxRateKey' }],
        req,
      })
    }
    return data
  }

export type Validator<T> = (value: T) => string | true

export const wholeNumber =
  (
    label: string,
    { min, optional = false }: { min?: number; optional?: boolean },
  ): Validator<null | number | undefined> =>
  (value) => {
    if (value === null || value === undefined) return optional ? true : `${label} is required`
    if (!Number.isSafeInteger(value)) return `${label} must be a whole number`
    return min === undefined || value >= min ? true : `${label} must be a whole number, ${min} or more`
  }

export const validatePrice: Validator<null | number | undefined> = (value) =>
  isMinorUnits(value)
    ? true
    : 'Price must be a whole number of minor units, 0 or more (VUV has none, so 2500 is Vt 2,500)'

export const validateCatalogKey =
  (example: string): Validator<null | string | undefined> =>
  (value) =>
    value && CATALOG_KEY_PATTERN.test(value)
      ? true
      : `Use lowercase letters, numbers and single hyphens, for example ${example}`

export const validateName: Validator<null | string | undefined> = (value) =>
  typeof value === 'string' && value.trim() ? true : 'Name is required'

export const validateTaxRateKey: Validator<null | string | undefined> = (value) =>
  value === null || value === undefined || value === '' || CATALOG_KEY_PATTERN.test(value)
    ? true
    : 'Use the key of one of the tenant’s tax rates, e.g. standard'

/** `taxExempt` and `taxRateKey`, the same on plans and add-ons. */
export const catalogTaxFields = (): Field[] => [
  {
    type: 'row',
    fields: [
      {
        name: 'taxExempt',
        type: 'checkbox',
        defaultValue: false,
        admin: { description: 'Never taxed, whatever the tenant’s rates.' },
      },
      {
        name: 'taxRateKey',
        type: 'text',
        validate: validateTaxRateKey,
        admin: { description: 'One of the tenant’s tax rate keys. Empty: the tenant’s default rate.' },
      },
    ],
  },
]

/**
 * Seed data names tax rates by key too. Check every key against the tenant before writing
 * anything, so a bad key can't stop a seed half way.
 */
export const missingTaxRateKeys = async ({
  keys,
  payload,
  req,
  tenantID,
  tenantsSlug = 'tenants',
}: {
  keys: readonly string[]
  payload: { findByID: (args: never) => Promise<unknown> }
  req?: unknown
  tenantID: number | string
  tenantsSlug?: string
}): Promise<string[]> => {
  if (keys.length === 0) return []
  const tenant = (await payload.findByID({
    collection: tenantsSlug,
    depth: 0,
    disableErrors: true,
    id: tenantID,
    overrideAccess: true,
    req,
  } as never)) as null | { tax?: { rates?: { key?: unknown }[] | null } | null }
  const known = new Set((tenant?.tax?.rates ?? []).map((rate) => rate?.key))
  return [...new Set(keys)].filter((key) => !known.has(key))
}

export const optionalBoolean =
  (label: string): Validator<unknown> =>
  (value) =>
    value === null || value === undefined || typeof value === 'boolean'
      ? true
      : `${label} must be true or false`
