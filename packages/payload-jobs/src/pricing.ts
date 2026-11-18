import { isMinorUnits, percentOf, sumMinorUnits } from './money'

/**
 * The pricing engine. `quote()` turns a plan, paid add-ons, an optional coupon and the
 * organisation's job credits into line items, discounts and a total.
 *
 * - **Pure and deterministic.** The same input always gives the same output. Nothing is read
 *   from the database or the clock, and the input is never mutated.
 * - **Integer money only.** Every amount is whole minor units of one currency (see `money.ts`).
 *   The only rounding is a coupon percentage, through the shared `percentOf`.
 * - **Never negative.** Discounts are capped at what is left to pay, so the total is 0 or more.
 *
 * Orders (PJ-23) store `snapshotQuote(quote(...))`, never a reference to the plan. Editing or
 * archiving a plan later never changes what a past order says was bought or paid.
 */

export const PLAN_STATUSES = ['active', 'archived'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export type DocumentID = number | string

/** How a quote line points back at the document it came from. */
export type PricedRef = {
  id: DocumentID
  /** Stable per-tenant identifier, e.g. `regular-listing`. */
  key?: null | string
  /** WordPress post id, for imported data. */
  legacyId?: null | number
}

/** An add-on as `quote()` reads it. An add-ons collection document satisfies this. */
export type QuotableAddOn = PricedRef & {
  /** `false` when the add-on is no longer sold on its own. Plans and grants still honour it. */
  active?: boolean | null
  currency: string
  durationDays: number
  /**
   * Other add-ons this one gives for free, each for its own duration (Premium gives 30 days of
   * Enhanced). Granted add-ons' own grants are followed too; a cycle is cut, never looped.
   */
  grants?: null | readonly AddOnGrant[]
  name: string
  /** Where the add-on shows the job, e.g. `featured-in-listings` (see `ADD_ON_PLACEMENTS`). */
  placement?: null | string
  price: number
}

/**
 * An add-on, populated or as an id. An id is looked up in `QuoteArgs.addOnCatalog`, so plans
 * and grants read at depth 0 can be quoted without populating every level.
 */
export type AddOnRef = DocumentID | QuotableAddOn

export type AddOnGrant = {
  addOn: AddOnRef
  durationDays: number
}

/** An add-on a plan includes at no extra charge, optionally for a different duration. */
export type IncludedAddOn = {
  addOn: AddOnRef
  /** Defaults to the add-on's own duration. */
  durationDays?: null | number
}

/** A plan as `quote()` reads it. A plans collection document satisfies this. */
export type QuotablePlan = PricedRef & {
  /** Whether one of the organisation's job credits can pay for this plan. Defaults to true. */
  acceptsCredits?: boolean | null
  /** Job categories the plan is limited to; every category on the job must be listed. Empty: any. */
  allowedJobCategories?: null | readonly TaxonomyRef[]
  /** Job types the plan is limited to. Empty: any. */
  allowedJobTypes?: null | readonly TaxonomyRef[]
  /** Days until unused credits from this plan expire; empty means they never expire. */
  creditExpiryDays?: null | number
  /** ISO 4217 code of `price`, copied from the tenant. */
  currency: string
  /** How long each listing bought with this plan stays live. */
  durationDays: number
  includedAddOns?: null | readonly IncludedAddOn[]
  /** Only for voluntary jobs. */
  isVolunteer?: boolean | null
  /** Listings this plan buys: 1 for a single listing, N for a pack. */
  jobCredits: number
  name: string
  price: number
  status: PlanStatus
}

export const QUOTE_COUPON_DISCOUNT_TYPES = ['flat', 'percent'] as const
export type QuoteCouponDiscountType = (typeof QUOTE_COUPON_DISCOUNT_TYPES)[number]

/**
 * The coupon fields a quote reads. These are the same as the coupon fields `applyCoupon`
 * reads (PJ-22), so a coupon document works as is.
 */
export type QuoteCouponTerms = {
  active?: boolean | null
  /** Flat: minor units. Percent: a whole percentage from 1 to 100. */
  amount?: null | number
  code?: null | string
  discountType?: null | string
  id?: DocumentID
  maxUses?: null | number
  useCount?: null | number
}

export type QuoteCouponRejection =
  | 'inactive'
  | 'invalid-amount'
  | 'unsupported-discount-type'
  | 'used-up'

/** A job type or category: its id, or the document itself (depth 1 or more). */
export type TaxonomyRef = DocumentID | { id: DocumentID; isVolunteer?: boolean | null }

/**
 * The job a plan is bought for (PJ-19's type and categories).
 *
 * Whether the job is voluntary comes only from its job type document's own `isVolunteer` flag,
 * never from the caller, so a volunteer-only plan needs `type` populated (depth 1 or more).
 */
export type QuoteJob = {
  categories?: null | readonly TaxonomyRef[]
  type?: null | TaxonomyRef
}

export type QuoteArgs = {
  /**
   * The tenant's add-ons, to resolve add-ons given by id in `plan.includedAddOns` and in grants.
   * Not needed when those are populated.
   */
  addOnCatalog?: readonly QuotableAddOn[]
  /** Add-ons bought on top of the plan. Each one may appear once. */
  addOns?: readonly QuotableAddOn[]
  /** Job credits the organisation holds. A plan that accepts credits uses one instead of cash. */
  availableCredits?: number
  coupon?: null | QuoteCouponTerms
  /** The tenant's currency. When given, the plan and every add-on must match it. */
  currency?: string
  /**
   * The job the plan is for. Required when the plan has restrictions; a plan with none (a pack
   * bought up front, say) can be quoted without one.
   */
  job?: null | QuoteJob
  plan: QuotablePlan
}

export type QuoteLineKind = 'add-on' | 'plan'

export type QuoteLine = {
  /** What the customer pays for this line before discounts: 0 when the plan includes it. */
  amount: number
  durationDays: number
  /** True for an add-on that comes with the plan. */
  included: boolean
  kind: QuoteLineKind
  name: string
  placement: null | string
  ref: PricedRef
  /** The list price, kept even when the line is included, for invoices and reports. */
  unitPrice: number
}

export type QuoteCouponResult = {
  /** The coupon value as quoted: minor units for flat, a percentage for percent. */
  amount: null | number
  applied: boolean
  code: null | string
  discount: number
  discountType: null | string
  id: DocumentID | null
  reason: null | QuoteCouponRejection
}

export type AddOnEntitlementSource = 'grant' | 'plan' | 'purchase'

export type AddOnEntitlement = {
  durationDays: number
  /** For a grant, the add-on that gave it; otherwise `null`. */
  grantedBy: null | PricedRef
  name: string
  placement: null | string
  ref: PricedRef
  /** `plan`: included in the plan. `purchase`: bought. `grant`: given by another add-on. */
  source: AddOnEntitlementSource
}

/** What the order gives the organisation once it is paid. */
export type QuoteEntitlements = {
  addOns: AddOnEntitlement[]
  /** Days until unused credits expire; `null` means never. */
  creditExpiryDays: null | number
  /** New job credits granted. 0 when an existing credit paid for the plan. */
  jobCreditsGranted: number
  /** How long each listing stays live. */
  listingDays: number
}

export type Quote = {
  coupon: null | QuoteCouponResult
  credits: {
    available: number
    /** The part of the subtotal the credit paid for. */
    discount: number
    used: number
  }
  currency: string
  /** Credits plus coupon, never more than the subtotal. */
  discount: number
  entitlements: QuoteEntitlements
  /** The job as quoted, or `null` when none was given. */
  job: null | {
    categories: DocumentID[]
    /** The job type's flag; `null` when the type was given as a bare id, so it is unknown. */
    isVolunteer: boolean | null
    type: DocumentID | null
  }
  lines: QuoteLine[]
  plan: PricedRef & {
    allowedJobCategories: DocumentID[]
    allowedJobTypes: DocumentID[]
    creditExpiryDays: null | number
    durationDays: number
    isVolunteer: boolean
    jobCredits: number
    name: string
    price: number
  }
  /** Sum of the line amounts. */
  subtotal: number
  /** Subtotal minus discount, never below 0. */
  total: number
}

export const QUOTE_SNAPSHOT_VERSION = 1

/**
 * What an order stores (PJ-23). A plain JSON value with no references to live documents.
 * Bump `QUOTE_SNAPSHOT_VERSION` if the shape ever changes, so old orders can still be read.
 */
export type QuoteSnapshot = DeepReadonly<Quote & { version: typeof QUOTE_SNAPSHOT_VERSION }>

type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

export const PRICING_ERROR_CODES = [
  'add-on-included',
  'add-on-inactive',
  'currency-mismatch',
  'duplicate-add-on',
  'invalid-add-on',
  'invalid-coupon',
  'invalid-credits',
  'invalid-job',
  'invalid-plan',
  'job-not-allowed',
  'job-required',
  'plan-archived',
] as const
export type PricingErrorCode = (typeof PRICING_ERROR_CODES)[number]

/** Bad input to `quote()`. Callers show `message` and branch on `code`. */
export class PricingError extends Error {
  readonly code: PricingErrorCode

  constructor(code: PricingErrorCode, message: string) {
    super(message)
    this.name = 'PricingError'
    this.code = code
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const refOf = ({ id, key, legacyId }: PricedRef): PricedRef => ({
  id,
  key: key ?? null,
  legacyId: legacyId ?? null,
})

const sameID = (a: DocumentID, b: DocumentID): boolean => String(a) === String(b)

/** The id of a taxonomy reference, or null when it isn't one. */
const taxonomyID = (ref: unknown): DocumentID | null => {
  const id = typeof ref === 'object' && ref !== null ? (ref as { id?: unknown }).id : ref
  if (typeof id === 'number' && Number.isSafeInteger(id)) return id
  if (typeof id === 'string' && id !== '') return id
  return null
}

const taxonomyIDs = (refs: null | readonly TaxonomyRef[] | undefined): DocumentID[] =>
  (refs ?? []).map((ref) => taxonomyID(ref) as DocumentID)

const validatePlan = (plan: QuotablePlan, currency: string | undefined): void => {
  const fail = (message: string): never => {
    throw new PricingError('invalid-plan', `Plan "${plan?.name ?? '?'}": ${message}`)
  }

  if (!plan || typeof plan !== 'object') fail('a plan is required')
  if (plan.id === null || plan.id === undefined) fail('the plan has no id')
  if (!isMinorUnits(plan.price)) fail('price must be a whole number of minor units, 0 or more')
  if (!CURRENCY_PATTERN.test(plan.currency ?? '')) fail('currency must be an ISO 4217 code')
  if (!isPositiveInteger(plan.durationDays)) fail('duration must be a whole number of days, 1 or more')
  if (!isPositiveInteger(plan.jobCredits)) fail('job credits must be a whole number, 1 or more')
  if (plan.creditExpiryDays !== null && plan.creditExpiryDays !== undefined) {
    if (!isPositiveInteger(plan.creditExpiryDays)) {
      fail('credit expiry must be a whole number of days, 1 or more, or empty')
    }
  }
  for (const name of ['allowedJobTypes', 'allowedJobCategories'] as const) {
    const refs = plan[name]
    if (refs !== null && refs !== undefined) {
      if (!Array.isArray(refs) || refs.some((ref) => taxonomyID(ref) === null)) {
        fail(`${name} must be a list of job ${name === 'allowedJobTypes' ? 'types' : 'categories'}`)
      }
    }
  }
  if (plan.isVolunteer !== null && plan.isVolunteer !== undefined && typeof plan.isVolunteer !== 'boolean') {
    fail('isVolunteer must be true or false')
  }
  if (plan.status === 'archived') {
    throw new PricingError('plan-archived', `Plan "${plan.name}" is archived and can't be bought`)
  }
  if (plan.status !== 'active') fail('status must be active or archived')
  if (currency !== undefined && plan.currency !== currency) {
    throw new PricingError(
      'currency-mismatch',
      `Plan "${plan.name}" is priced in ${plan.currency}, not ${currency}`,
    )
  }
}

const validateAddOn = (addOn: QuotableAddOn, currency: string): void => {
  const fail = (message: string): never => {
    throw new PricingError('invalid-add-on', `Add-on "${addOn?.name ?? '?'}": ${message}`)
  }

  if (!addOn || typeof addOn !== 'object') fail('an add-on is required')
  if (addOn.id === null || addOn.id === undefined) fail('the add-on has no id')
  if (!isMinorUnits(addOn.price)) fail('price must be a whole number of minor units, 0 or more')
  if (!isPositiveInteger(addOn.durationDays)) {
    fail('duration must be a whole number of days, 1 or more')
  }
  if (addOn.currency !== currency) {
    throw new PricingError(
      'currency-mismatch',
      `Add-on "${addOn.name}" is priced in ${addOn.currency}, not ${currency}`,
    )
  }
}

/** Look up an add-on given populated or by id (in the catalog). */
const addOnResolver =
  (catalog: readonly QuotableAddOn[]) =>
  (ref: AddOnRef | null | undefined): QuotableAddOn => {
    if (ref !== null && typeof ref === 'object') return ref
    if (typeof ref === 'number' || (typeof ref === 'string' && ref !== '')) {
      const found = catalog.find((addOn) => addOn && sameID(addOn.id, ref))
      if (found) return found
      throw new PricingError(
        'invalid-add-on',
        `Add-on ${ref} is not populated and not in addOnCatalog`,
      )
    }
    throw new PricingError('invalid-add-on', 'An add-on reference is missing')
  }

/**
 * The add-ons `root` grants, depth first in the order they are listed, each for the grant's own
 * duration. A granted add-on's grants are followed too. Each add-on appears at most once per
 * root, and never the root itself, so a cycle (A grants B grants A) ends instead of looping.
 * Granted add-ons are free whether or not they are still sold on their own.
 */
const grantsOf = (
  root: QuotableAddOn,
  currency: string,
  resolve: ReturnType<typeof addOnResolver>,
): AddOnEntitlement[] => {
  const seen: DocumentID[] = [root.id]
  const result: AddOnEntitlement[] = []

  const walk = (giver: QuotableAddOn): void => {
    const grants = giver.grants ?? []
    if (!Array.isArray(grants)) {
      throw new PricingError('invalid-add-on', `Add-on "${giver.name}": grants must be a list`)
    }

    for (const grant of grants) {
      const granted = resolve(grant?.addOn)
      validateAddOn(granted, currency)
      if (!isPositiveInteger(grant.durationDays)) {
        throw new PricingError(
          'invalid-add-on',
          `Add-on "${giver.name}": the duration of the "${granted.name}" it grants must be a whole number of days, 1 or more`,
        )
      }
      if (seen.some((id) => sameID(id, granted.id))) continue
      seen.push(granted.id)

      result.push({
        durationDays: grant.durationDays,
        grantedBy: refOf(giver),
        name: granted.name,
        placement: granted.placement ?? null,
        ref: refOf(granted),
        source: 'grant',
      })
      walk(granted)
    }
  }

  walk(root)
  return result
}

const failJob = (message: string): never => {
  throw new PricingError('invalid-job', `Job: ${message}`)
}

const normalizeJob = (job: QuoteJob): NonNullable<Quote['job']> => {
  if (typeof job !== 'object' || job === null) failJob('a job must be an object')

  const type = job.type === null || job.type === undefined ? null : taxonomyID(job.type)
  if (job.type !== null && job.type !== undefined && type === null) failJob('type must be a job type')

  const categories = job.categories ?? []
  if (!Array.isArray(categories) || categories.some((ref) => taxonomyID(ref) === null)) {
    failJob('categories must be a list of job categories')
  }
  // A caller-supplied flag can't be checked, so it is refused rather than trusted.
  if ('isVolunteer' in job) {
    failJob('isVolunteer comes from the job type; pass the populated type instead')
  }

  const typeFlag =
    typeof job.type === 'object' && job.type !== null ? job.type.isVolunteer : undefined
  if (typeFlag !== null && typeFlag !== undefined && typeof typeFlag !== 'boolean') {
    failJob("the job type's isVolunteer must be true or false")
  }

  return {
    categories: taxonomyIDs(categories),
    // A populated type without the flag stored is a type that isn't voluntary (the field
    // defaults to false); a bare id tells us nothing.
    isVolunteer: typeof job.type === 'object' && job.type !== null ? typeFlag === true : null,
    type,
  }
}

/**
 * Throw unless the plan may be used for this job. A plan with no restrictions allows any job,
 * or no job. A restricted plan needs the job:
 * - `isVolunteer`: the job type must be a populated document flagged voluntary. A bare type id
 *   is refused as `invalid-job`, because it can't show that the job is voluntary.
 * - `allowedJobTypes`: the job's type must be listed.
 * - `allowedJobCategories`: the job needs at least one category, and every one must be listed,
 *   so a cheaper category plan can't be stretched over a listing in other categories.
 */
const assertJobAllowed = (plan: QuotablePlan, job: Quote['job']): void => {
  const types = taxonomyIDs(plan.allowedJobTypes).map(String)
  const categories = taxonomyIDs(plan.allowedJobCategories).map(String)
  const volunteerOnly = plan.isVolunteer === true

  if (!volunteerOnly && types.length === 0 && categories.length === 0) return

  if (!job) {
    throw new PricingError('job-required', `Plan "${plan.name}" is only for some jobs; say which job`)
  }

  const refuse = (why: string): never => {
    throw new PricingError('job-not-allowed', `Plan "${plan.name}" ${why}`)
  }

  if (volunteerOnly) {
    if (job.type === null) refuse('needs a voluntary job type')
    if (job.isVolunteer === null) {
      throw new PricingError(
        'invalid-job',
        `Plan "${plan.name}" is only for voluntary jobs; pass the job type document to check it`,
      )
    }
    if (!job.isVolunteer) refuse('is only for voluntary jobs')
  }
  if (types.length > 0 && (job.type === null || !types.includes(String(job.type)))) {
    refuse(job.type === null ? 'needs a job type' : `is not for job type ${job.type}`)
  }
  if (categories.length > 0) {
    if (job.categories.length === 0) refuse('needs a job category')
    const outside = job.categories.find((id) => !categories.includes(String(id)))
    if (outside !== undefined) refuse(`is not for job category ${outside}`)
  }
}

/** Mirrors `applyCoupon` (PJ-22): the same rejections, and the shared `percentOf` rounding. */
const evaluateCoupon = (
  coupon: QuoteCouponTerms,
  base: number,
): { discount: number; reason: null | QuoteCouponRejection } => {
  if (coupon.active === false) return { discount: 0, reason: 'inactive' }

  const useCount = coupon.useCount ?? 0
  if (!Number.isSafeInteger(useCount) || useCount < 0) {
    throw new PricingError('invalid-coupon', 'Coupon use count must be a whole number, 0 or more')
  }
  if (coupon.maxUses !== null && coupon.maxUses !== undefined && useCount >= coupon.maxUses) {
    return { discount: 0, reason: 'used-up' }
  }

  const amount = coupon.amount ?? null
  if (amount === null || !Number.isSafeInteger(amount) || amount < 1) {
    return { discount: 0, reason: 'invalid-amount' }
  }

  switch (coupon.discountType) {
    case 'flat':
      return { discount: Math.min(amount, base), reason: null }
    case 'percent':
      if (amount > 100) return { discount: 0, reason: 'invalid-amount' }
      return { discount: Math.min(percentOf(base, amount), base), reason: null }
    default:
      return { discount: 0, reason: 'unsupported-discount-type' }
  }
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/**
 * Price a purchase. Throws `PricingError` for input that can't be sold (an archived plan, a job
 * the plan doesn't allow, an inactive or duplicate add-on, mixed currencies, malformed amounts). A coupon that doesn't
 * apply is not an error: the quote says why in `coupon.reason` and charges full price.
 *
 * Order of operations:
 * 1. Lines: the plan, the add-ons the plan includes (charged 0), then the paid add-ons.
 * 2. Credits: if the plan is a single listing that accepts credits, costs more than 0 and the
 *    organisation has a credit, one credit pays the plan line. Add-ons are still charged.
 * 3. Coupon: applied to what is left after credits, capped at that amount.
 */
export const quote = ({
  addOnCatalog = [],
  addOns = [],
  availableCredits = 0,
  coupon = null,
  currency,
  job = null,
  plan,
}: QuoteArgs): Quote => {
  validatePlan(plan, currency)

  if (!Number.isSafeInteger(availableCredits) || availableCredits < 0) {
    throw new PricingError('invalid-credits', 'Available credits must be a whole number, 0 or more')
  }

  const quotedJob = job ? normalizeJob(job) : null
  assertJobAllowed(plan, quotedJob)

  const lines: QuoteLine[] = [
    {
      amount: plan.price,
      durationDays: plan.durationDays,
      included: false,
      kind: 'plan',
      name: plan.name,
      placement: null,
      ref: refOf(plan),
      unitPrice: plan.price,
    },
  ]
  const entitlementAddOns: AddOnEntitlement[] = []
  const includedIDs: DocumentID[] = []

  const resolve = addOnResolver(addOnCatalog)

  for (const included of plan.includedAddOns ?? []) {
    const addOn = resolve(included?.addOn)
    validateAddOn(addOn, plan.currency)

    if (includedIDs.some((id) => sameID(id, addOn.id))) {
      throw new PricingError('duplicate-add-on', `Plan "${plan.name}" includes "${addOn.name}" twice`)
    }
    includedIDs.push(addOn.id)

    const durationDays = included.durationDays ?? addOn.durationDays
    if (!isPositiveInteger(durationDays)) {
      throw new PricingError(
        'invalid-plan',
        `Plan "${plan.name}": the duration of "${addOn.name}" must be a whole number of days, 1 or more`,
      )
    }

    const placement = addOn.placement ?? null
    lines.push({
      amount: 0,
      durationDays,
      included: true,
      kind: 'add-on',
      name: addOn.name,
      placement,
      ref: refOf(addOn),
      unitPrice: addOn.price,
    })
    entitlementAddOns.push({
      durationDays,
      grantedBy: null,
      name: addOn.name,
      placement,
      ref: refOf(addOn),
      source: 'plan',
    })
    entitlementAddOns.push(...grantsOf(addOn, plan.currency, resolve))
  }

  const purchasedIDs: DocumentID[] = []

  for (const addOn of addOns) {
    validateAddOn(addOn, plan.currency)

    if (purchasedIDs.some((id) => sameID(id, addOn.id))) {
      throw new PricingError('duplicate-add-on', `Add-on "${addOn.name}" was added twice`)
    }
    if (includedIDs.some((id) => sameID(id, addOn.id))) {
      throw new PricingError(
        'add-on-included',
        `Plan "${plan.name}" already includes "${addOn.name}"`,
      )
    }
    if (addOn.active === false) {
      throw new PricingError('add-on-inactive', `Add-on "${addOn.name}" is no longer sold`)
    }
    purchasedIDs.push(addOn.id)

    const placement = addOn.placement ?? null
    lines.push({
      amount: addOn.price,
      durationDays: addOn.durationDays,
      included: false,
      kind: 'add-on',
      name: addOn.name,
      placement,
      ref: refOf(addOn),
      unitPrice: addOn.price,
    })
    entitlementAddOns.push({
      durationDays: addOn.durationDays,
      grantedBy: null,
      name: addOn.name,
      placement,
      ref: refOf(addOn),
      source: 'purchase',
    })
    entitlementAddOns.push(...grantsOf(addOn, plan.currency, resolve))
  }

  const subtotal = sumMinorUnits(lines.map((line) => line.amount))

  const creditEligible = plan.jobCredits === 1 && plan.acceptsCredits !== false && plan.price > 0
  const creditsUsed = creditEligible && availableCredits >= 1 ? 1 : 0
  const creditDiscount = creditsUsed === 1 ? plan.price : 0
  const afterCredits = subtotal - creditDiscount

  let couponResult: null | QuoteCouponResult = null

  if (coupon) {
    const { discount, reason } = evaluateCoupon(coupon, afterCredits)
    couponResult = {
      amount: coupon.amount ?? null,
      applied: reason === null,
      code: coupon.code ?? null,
      discount,
      discountType: coupon.discountType ?? null,
      id: coupon.id ?? null,
      reason,
    }
  }

  const discount = creditDiscount + (couponResult?.discount ?? 0)
  const creditExpiryDays = plan.creditExpiryDays ?? null

  return deepFreeze({
    coupon: couponResult,
    credits: { available: availableCredits, discount: creditDiscount, used: creditsUsed },
    currency: plan.currency,
    discount,
    entitlements: {
      addOns: entitlementAddOns,
      creditExpiryDays,
      jobCreditsGranted: creditsUsed === 1 ? 0 : plan.jobCredits,
      listingDays: plan.durationDays,
    },
    job: quotedJob,
    lines,
    plan: {
      ...refOf(plan),
      allowedJobCategories: taxonomyIDs(plan.allowedJobCategories),
      allowedJobTypes: taxonomyIDs(plan.allowedJobTypes),
      creditExpiryDays,
      durationDays: plan.durationDays,
      isVolunteer: plan.isVolunteer === true,
      jobCredits: plan.jobCredits,
      name: plan.name,
      price: plan.price,
    },
    subtotal,
    total: subtotal - discount,
  })
}

/**
 * The value an order stores: a deep, frozen copy of the quote with a version number. It is
 * plain JSON, so it round-trips through a `json` field unchanged.
 */
export const snapshotQuote = (value: Quote): QuoteSnapshot =>
  deepFreeze({ ...structuredClone(value), version: QUOTE_SNAPSHOT_VERSION }) as QuoteSnapshot
