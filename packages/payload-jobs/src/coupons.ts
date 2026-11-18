import {
  ValidationError,
  type Access,
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  type CollectionConfig,
  type CollectionSlug,
  type SelectField,
  type TextField,
} from 'payload'

import {
  authenticatedAccess,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  isSuperAdmin,
  type MissionControlUser,
} from './access'

/**
 * Discount codes, replacing the WordPress `appthemes-coupons` plugin (see AUDIT.md).
 * A code is worth either a flat amount or a percentage of the order subtotal.
 */

export const COUPONS_SLUG = 'coupons'

export const COUPON_DISCOUNT_TYPES = ['flat', 'percent'] as const
export type CouponDiscountType = (typeof COUPON_DISCOUNT_TYPES)[number]

/** Coupons are money, so only a tenant-admin changes them. */
export const COUPON_EDITOR_ROLES = ['tenant-admin'] as const

export const COUPON_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/

export const normalizeCouponCode = (value: string): string => value.trim().toUpperCase()

export const validateCouponCode = (value: null | string | undefined): string | true =>
  value && COUPON_CODE_PATTERN.test(value)
    ? true
    : 'Use uppercase letters, numbers, hyphens and underscores, for example LINKPS'

const tenantIDOf = (tenant: unknown): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return (tenant as { id?: number | string }).id ?? null
  return tenant as number | string
}

const editorTenantIDs = (user: MissionControlUser): (number | string)[] =>
  getUserTenantIDsByRole(user, COUPON_EDITOR_ROLES)

const canEditCoupons = (user: MissionControlUser): boolean =>
  isSuperAdmin(user) || hasAnyTenantRole(user, COUPON_EDITOR_ROLES)

/**
 * Update and delete access. In multi-tenant mode the write is scoped to the tenants where the
 * user is a tenant-admin; their data is partial, so an omitted `tenant` is normal. In
 * single-tenant mode there is no `tenant` field to scope, so the role check is the whole rule.
 */
export const couponWriteAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = req.user as MissionControlUser | null | undefined

    if (!user) return false
    if (!tenantScoped) return canEditCoupons(user)
    if (isSuperAdmin(user)) return true

    const tenantIDs = editorTenantIDs(user)
    if (tenantIDs.length === 0) return false

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted !== null && !tenantIDs.some((id) => String(id) === String(submitted))) return false

    return { tenant: { in: tenantIDs } }
  }

/**
 * Create needs the tenant in the submitted data: a `where` result does not filter create
 * data, so a create with no tenant would store a coupon that belongs to no tenant. That
 * includes super admins, who bypass the tenant list but not the tenant requirement.
 * Single-tenant mode has no `tenant` field, so it falls back to the role check alone.
 */
export const couponCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = req.user as MissionControlUser | null | undefined

    if (!user) return false
    if (!tenantScoped) return canEditCoupons(user)

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    if (isSuperAdmin(user)) return true

    return editorTenantIDs(user).some((id) => String(id) === String(submitted))
  }

/** Uppercase the code before validation so `linkps` and `LINKPS` are the same coupon. */
export const normalizeCouponCodeHook: CollectionBeforeValidateHook = ({ data }) => {
  if (typeof data?.code !== 'string') return data

  return { ...data, code: normalizeCouponCode(data.code) }
}

/**
 * Reject a code another coupon in the same tenant already uses, as a field error rather
 * than a raw unique-index failure. The index still guards against concurrent writes.
 */
export const uniqueCodePerTenant =
  (collectionSlug: CollectionSlug): CollectionBeforeValidateHook =>
  async ({ data, originalDoc, req }) => {
    const code = typeof data?.code === 'string' ? normalizeCouponCode(data.code) : ''
    const tenantID = tenantIDOf(data?.tenant ?? originalDoc?.tenant)

    if (!code || tenantID === null) return data

    const selfID = originalDoc?.id
    const { docs } = await req.payload.find({
      collection: collectionSlug,
      depth: 0,
      limit: 2,
      overrideAccess: true,
      pagination: false,
      req,
      where: {
        and: [{ code: { equals: code } }, { tenant: { equals: tenantID } }],
      },
    })

    const conflict = docs.some((doc) => selfID === undefined || String(doc.id) !== String(selfID))
    if (conflict) {
      throw new ValidationError({
        collection: collectionSlug,
        errors: [{ message: `Code "${code}" is already used in this tenant`, path: 'code' }],
        req,
      })
    }

    return data
  }

/**
 * Set this on `req.context` to let trusted order code change `useCount`. Without it the count is
 * pinned, because `admin.readOnly` only hides a field in the admin UI: a tenant admin could
 * otherwise lower the count through REST or GraphQL and make an exhausted coupon usable again.
 */
export const COUPON_USE_COUNT_CONTEXT = 'couponUseCount'

/**
 * Keep `useCount` at its stored value unless the request comes from order processing. A new
 * coupon starts at 0.
 *
 * An explicit `null` counts as a change, not as an omission: otherwise a request could clear
 * the count and `applyCoupon` would read it as zero uses.
 */
export const protectCouponUseCount: CollectionBeforeChangeHook = ({
  context,
  data,
  operation,
  originalDoc,
}) => {
  if (context?.[COUPON_USE_COUNT_CONTEXT] === true) return data

  const current = operation === 'update' ? (originalDoc?.useCount ?? 0) : 0
  if (data?.useCount === current) return data

  return { ...data, useCount: current }
}

/** A coupon is worth a flat amount in the tenant's minor units, or a whole percentage. */
export const validateCouponAmount = (
  value: null | number | undefined,
  options: { siblingData?: Record<string, unknown> },
): string | true => {
  const discountType = options.siblingData?.discountType

  if (discountType === 'percent') {
    if (value === null || value === undefined) return 'Percentage is required'
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      return 'Use a whole percentage between 1 and 100'
    }
    return true
  }

  if (value === null || value === undefined) return 'Discount amount is required'
  if (!Number.isInteger(value) || value < 1) {
    return 'Use a whole number of minor units, 1 or more'
  }
  return true
}

/** The count starts at 0 and only order processing changes it, so it always holds a number. */
export const validateCouponUseCount = (value: null | number | undefined): string | true =>
  value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
    ? true
    : 'Use a whole number, 0 or more'

export const validateCouponMaxUses = (value: null | number | undefined): string | true =>
  value === null || value === undefined || (Number.isInteger(value) && value >= 1)
    ? true
    : 'Use a whole number, 1 or more, or leave it empty for unlimited'

export type CouponCollectionOptions = {
  /** Set to `false` in single-tenant mode, where there is no `tenants` collection. */
  tenantScoped?: boolean
}

export const couponCollection = ({
  tenantScoped = true,
}: CouponCollectionOptions = {}): CollectionConfig => ({
  slug: COUPONS_SLUG,
  access: {
    create: couponCreateAccess(tenantScoped),
    delete: couponWriteAccess(tenantScoped),
    read: authenticatedAccess,
    update: couponWriteAccess(tenantScoped),
  },
  admin: {
    defaultColumns: ['code', 'discountType', 'amount', 'active', 'useCount', 'maxUses'],
    group: 'Job board',
    useAsTitle: 'code',
  },
  fields: [
    {
      name: 'code',
      type: 'text',
      index: true,
      required: true,
      unique: !tenantScoped,
      validate: validateCouponCode,
      admin: {
        description: 'Saved in uppercase. Unique within the tenant, for example LINKPS.',
      },
    } as TextField,
    {
      name: 'discountType',
      type: 'select',
      defaultValue: 'flat',
      options: [
        { label: 'Flat amount', value: 'flat' },
        { label: 'Percentage', value: 'percent' },
      ],
      required: true,
    } as SelectField,
    {
      name: 'amount',
      type: 'number',
      admin: {
        description:
          'Flat: minor units of the tenant currency, so 500 is Vt 500. Percentage: a whole percentage, so 10 is 10%.',
        step: 1,
      },
      required: true,
      validate: validateCouponAmount,
    },
    {
      name: 'active',
      type: 'checkbox',
      defaultValue: true,
      admin: {
        description: 'An inactive coupon is kept but cannot be applied.',
      },
    },
    {
      name: 'useCount',
      type: 'number',
      defaultValue: 0,
      min: 0,
      required: true,
      admin: {
        description:
          'How many orders have used the coupon. Only order processing changes it; other writes keep the stored value.',
        readOnly: true,
        step: 1,
      },
      validate: validateCouponUseCount,
    },
    {
      name: 'maxUses',
      type: 'number',
      min: 1,
      admin: {
        description: 'Leave empty for unlimited uses.',
        step: 1,
      },
      validate: validateCouponMaxUses,
    },
    {
      name: 'legacyId',
      type: 'number',
      index: true,
      admin: {
        description: 'WordPress post id, for the import.',
      },
    },
  ],
  hooks: {
    beforeChange: [protectCouponUseCount],
    beforeValidate: [normalizeCouponCodeHook, uniqueCodePerTenant(COUPONS_SLUG)],
  },
  // The unique index spans the tenant, so the same code may exist on two tenants.
  indexes: tenantScoped ? [{ fields: ['tenant', 'code'], unique: true }] : [],
  labels: { plural: 'Coupons', singular: 'Coupon' },
  versions: false,
})

/** The coupon fields `applyCoupon` reads. A full coupon document satisfies this. */
export type CouponTerms = {
  active?: boolean | null
  amount?: null | number
  discountType?: CouponDiscountType | null
  maxUses?: null | number
  useCount?: null | number
}

/** Why a coupon was not applied. `null` means it was, or none was given. */
export type CouponRejection = 'inactive' | 'invalid-amount' | 'unsupported-discount-type' | 'used-up'

export type CouponApplication = {
  applied: boolean
  /** Discount in minor units, never more than the subtotal. */
  discount: number
  reason: null | CouponRejection
  /** Subtotal minus the discount, never below 0. */
  total: number
}

export type ApplyCouponArgs = {
  coupon?: CouponTerms | null
  /** Order subtotal in the tenant's minor units. */
  subtotal: number
}

/**
 * Work out the discount a coupon gives on a subtotal. Both values are whole minor units of
 * the tenant currency (VUV has 0 decimals, NZD has 2), so no rounding happens except when a
 * percentage produces a fraction of a minor unit.
 *
 * The discount never exceeds the subtotal, so the total floors at 0 rather than going
 * negative. An inactive coupon, or one that has reached `maxUses`, gives no discount.
 */
export const applyCoupon = ({ coupon, subtotal }: ApplyCouponArgs): CouponApplication => {
  if (!Number.isInteger(subtotal) || subtotal < 0) {
    throw new RangeError('subtotal must be a whole number of minor units, 0 or more')
  }

  const unchanged: CouponApplication = { applied: false, discount: 0, reason: null, total: subtotal }

  if (!coupon) return unchanged

  if (coupon.active === false) return { ...unchanged, reason: 'inactive' }

  const useCount = coupon.useCount ?? 0
  if (coupon.maxUses !== null && coupon.maxUses !== undefined && useCount >= coupon.maxUses) {
    return { ...unchanged, reason: 'used-up' }
  }

  // The collection validator requires 1 or more, so a zero-value coupon is not valid here
  // either: data that skips field validation would otherwise read as a working discount.
  const amount = coupon.amount ?? null
  if (amount === null || !Number.isInteger(amount) || amount < 1) {
    return { ...unchanged, reason: 'invalid-amount' }
  }

  let discount: number

  switch (coupon.discountType) {
    case 'flat':
      discount = amount
      break
    case 'percent':
      if (amount > 100) return { ...unchanged, reason: 'invalid-amount' }
      discount = Math.round((subtotal * amount) / 100)
      break
    default:
      return { ...unchanged, reason: 'unsupported-discount-type' }
  }

  const cappedDiscount = Math.min(Math.max(discount, 0), subtotal)

  return { applied: true, discount: cappedDiscount, reason: null, total: subtotal - cappedDiscount }
}
