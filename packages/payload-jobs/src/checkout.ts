import {
  createPayloadRequest,
  Forbidden,
  type CollectionSlug,
  type Endpoint,
  type GlobalSlug,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { getTenantRole, getUserOrganisationID, type MissionControlUser } from './access'
import {
  AccountAuthError,
  accountResponse,
  enforceRateLimit,
  resolveAccountTenant,
  resolveAccountUser,
  type AccountAuthOptions,
  type AccountTenant,
} from './account-auth'
import { idsOf, tenantIDOf } from './catalog'
import { normalizeCouponCode, COUPON_USE_COUNT_CONTEXT } from './coupons'
import {
  packCreditGrantProblem,
  tenantPackCreditMode,
  type PackCreditMode,
  type TenantPackCreditSource,
} from './credit-settings'
import {
  balanceFor,
  consumeCredit,
  CreditLedgerError,
  grantCredits,
  withOrganisationCreditLock,
} from './credits'
import {
  isOrganisationOwnerByRole,
  ORDER_SYSTEM_CONTEXT,
  orderActorFor,
  type OrderActor,
  type OrderStatus,
  type OrganisationOwnerCheck,
} from './orders'
import type { OrderPaymentMethod } from './payment-providers'
import type { CheckoutContext, PaymentResult } from './plug-points/definitions'
import { emitDeferredOrderEvents, ORDER_EVENTS_DEFER_CONTEXT, type DeferredOrderEvent } from './plug-points/gate'
import { createPayloadJobsRegistry, forTenant, type PayloadJobsRegistry } from './plug-points/payload-jobs-registry'
import {
  PricingError,
  quote,
  snapshotQuote,
  type DocumentID,
  type QuotableAddOn,
  type QuotablePlan,
  type Quote,
  type QuoteCouponTerms,
  type QuoteJob,
  type QuoteSnapshot,
} from './pricing'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'
import { tenantTaxSettings, type TenantTaxSource } from './tax-settings'
import { assertNotViewingAs } from './view-as'

/**
 * Checkout (PJ-31): plan + add-ons → coupon / credit → order, for one job.
 *
 * The rules, in the order they run:
 *
 * 1. **Who.** The caller is a site manager of the job's tenant, or an employer of the job's own
 *    organisation in that tenant. Everyone else gets `not_found`, so ids can't be probed.
 * 2. **One checkout per listing.** Everything below runs in one transaction holding the
 *    organisation's credit lock (`withOrganisationCreditLock`), so two submits for one
 *    organisation run one after the other. A job whose current order (`jobs.order`) is still open
 *    (not cancelled or failed) is never charged again: the same request returns that order with
 *    `created: false`; a different one is refused with `already_checked_out`.
 * 3. **Server-side price.** The plan, add-ons, coupon, tax and credit balance are read from the
 *    database and priced by `quote()`. The request carries ids and a code, never an amount.
 * 4. **Eligibility.** `quote()` applies the plan's job type, category and volunteer limits, and
 *    refuses archived plans, inactive add-ons and other currencies. A coupon that gives nothing
 *    is refused rather than silently charging full price (and spending a use).
 * 5. **Close date.** Optional; a calendar date in the tenant's timezone, after today and no later
 *    than today + the plan's duration. Without one the job runs the plan's full duration (the
 *    default close date is the maximum). Publishing clamps it to the plan's duration again.
 * 6. **Purchase rights** (decision 19 Nov). Owners and site managers may do anything. A member
 *    uses credits unless the owner turned that off (`useCredits`, default on) and buys only when
 *    allowed (`canBuy`, default off). A member who would owe money but may not buy creates the
 *    order as `waiting_for_purchase`; the owner approves it (`approvePurchase`) or declines it.
 * 7. **Payment** through the PJ-115 payment providers: `credit` when a credit pays it all, `free`
 *    when the total is 0, otherwise `invoice`. A pack plan's credits are granted through the
 *    ledger once its order is invoiced or paid, and one of them pays for this job.
 *
 * 8. **Nothing outside the database before the commit.** Checkout runs in a transaction of its
 *    own (`committed`). Order events are deferred: add-ons queue their durable work in that
 *    transaction (Xero's retry job), and their handlers run only once it has committed. A
 *    failed checkout or approval therefore never leaves a Xero draft or invoice behind.
 *
 * Out of scope: publishing and moderation (PJ-32: the job is left `pending`), the employer UI
 * (PJ-82), Xero (PJ-57 listens to the order events), relisting (PJ-33 duplicates the job).
 */

export const CHECKOUT_ERROR_CODES = [
  'already_checked_out',
  'close_date_invalid',
  'coupon_invalid',
  'coupon_unavailable',
  'forbidden',
  'insufficient_credits',
  'invalid_request',
  'job_not_checkoutable',
  'not_found',
  'order_not_waiting',
  'payment_failed',
  'pricing_error',
] as const
export type CheckoutErrorCode = (typeof CHECKOUT_ERROR_CODES)[number]

const STATUS_FOR: Record<CheckoutErrorCode, number> = {
  already_checked_out: 409,
  close_date_invalid: 400,
  coupon_invalid: 400,
  coupon_unavailable: 409,
  forbidden: 403,
  insufficient_credits: 409,
  invalid_request: 400,
  job_not_checkoutable: 409,
  not_found: 404,
  order_not_waiting: 409,
  payment_failed: 402,
  pricing_error: 400,
}

/** A refused checkout. `detail` carries the pricing code or the existing order id. */
export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly detail?: Record<string, unknown>
  readonly status: number

  constructor(code: CheckoutErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message)
    this.name = 'CheckoutError'
    this.code = code
    this.detail = detail
    this.status = STATUS_FOR[code]
  }
}

type ID = number | string
type Doc = Record<string, unknown> & { id: ID }

// ---------------------------------------------------------------------------------------------
// Input

export type CheckoutInput = {
  /** Add-ons bought on top of the plan, by id. */
  addOnIds: ID[]
  /** `YYYY-MM-DD` in the tenant's timezone, or null for the plan's full duration. */
  closeDate: null | string
  couponCode: null | string
  jobId: ID
  planId: ID
  /** Pay the plan with one of the organisation's credits when the plan accepts them. */
  useCredit: boolean
}

const isID = (value: unknown): value is ID =>
  (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value))

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const fail = (message: string): never => {
  throw new CheckoutError('invalid_request', message)
}

/**
 * Read a checkout request body. Only ids, a code, a date and a flag are read: amounts the client
 * sends (a total, a price) are ignored, never trusted.
 */
export const parseCheckoutInput = (body: unknown): CheckoutInput => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('The request body must be an object')
  const input = body as Record<string, unknown>

  if (!isID(input.jobId)) fail('jobId is required')
  if (!isID(input.planId)) fail('planId is required')

  const addOnIds = input.addOnIds ?? []
  if (!Array.isArray(addOnIds) || addOnIds.length > 50 || !addOnIds.every(isID)) {
    fail('addOnIds must be a list of add-on ids')
  }

  let couponCode: null | string = null
  if (input.couponCode !== undefined && input.couponCode !== null && input.couponCode !== '') {
    if (typeof input.couponCode !== 'string' || input.couponCode.length > 64) fail('couponCode must be text')
    couponCode = normalizeCouponCode(input.couponCode as string) || null
  }

  let closeDate: null | string = null
  if (input.closeDate !== undefined && input.closeDate !== null && input.closeDate !== '') {
    if (typeof input.closeDate !== 'string' || !DATE_PATTERN.test(input.closeDate)) {
      fail('closeDate must be a date like 2026-12-31')
    }
    closeDate = input.closeDate as string
  }

  if (input.useCredit !== undefined && typeof input.useCredit !== 'boolean') fail('useCredit must be true or false')

  return {
    addOnIds: addOnIds as ID[],
    closeDate,
    couponCode,
    jobId: input.jobId as ID,
    planId: input.planId as ID,
    useCredit: input.useCredit === true,
  }
}

// ---------------------------------------------------------------------------------------------
// Close date (pure)

const DAY_MS = 24 * 60 * 60 * 1000

const validTimeZone = (timeZone: unknown): string => {
  if (typeof timeZone !== 'string' || !timeZone) return 'UTC'
  try {
    return Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** The calendar date (`YYYY-MM-DD`) of `instant` in `timeZone`. */
export const localDateOf = (instant: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone, year: 'numeric' }).format(
    new Date(instant),
  )

/** How far `timeZone` is ahead of UTC at `instant`, in ms (whole seconds). */
const offsetAt = (instant: number, timeZone: string): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      second: 'numeric',
      timeZone,
      year: 'numeric',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUTC - Math.floor(instant / 1000) * 1000
}

/** The last millisecond of `date` (`YYYY-MM-DD`) in `timeZone`, as an ISO instant. */
export const endOfLocalDay = (date: string, timeZone: string): string => {
  const [year, month, day] = date.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  let result = guess - offsetAt(guess, timeZone)
  // Across a DST change the offset at the answer can differ from the offset at the guess.
  const second = guess - offsetAt(result, timeZone)
  if (second !== result) result = second
  return new Date(result).toISOString()
}

/**
 * Why `closeDate` can't be used for a plan running `durationDays`, or null. The date must be a
 * real calendar date after today and no later than the date `durationDays` from now, both in the
 * tenant's timezone.
 */
export const closeDateProblem = ({
  closeDate,
  durationDays,
  now,
  timeZone,
}: {
  closeDate: string
  durationDays: number
  now: Date
  timeZone: string
}): null | string => {
  const [year, month, day] = closeDate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    !DATE_PATTERN.test(closeDate) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return 'The close date is not a real date'
  }
  const tz = validTimeZone(timeZone)
  const today = localDateOf(now.getTime(), tz)
  const latest = localDateOf(now.getTime() + durationDays * DAY_MS, tz)
  if (closeDate <= today) return 'The close date must be after today'
  if (closeDate > latest) return `This plan runs for at most ${durationDays} days: close on ${latest} or earlier`
  return null
}

// ---------------------------------------------------------------------------------------------
// Purchase rights

export type PurchaseRights = { buy: boolean; useCredits: boolean }

/**
 * What `user` may spend for their organisation. PJ-29 adds the per-member switches the owner
 * sets; until then a member has the defaults (decision 19 Nov): use credits on, buy off.
 */
export type PurchaseRightsCheck = (args: {
  actor: OrderActor
  organisationID: ID
  req: PayloadRequest
  user: MissionControlUser | null
}) => Promise<PurchaseRights> | PurchaseRights

export const defaultPurchaseRights: PurchaseRightsCheck = ({ actor, user }) => {
  if (actor !== 'member') return { buy: true, useCredits: true }
  const member = (user ?? {}) as { canBuy?: unknown; useCredits?: unknown }
  return { buy: member.canBuy === true, useCredits: member.useCredits !== false }
}

// ---------------------------------------------------------------------------------------------
// Service options

export type CheckoutOptions = {
  /** Coupons collection on (`features.coupons`). Defaults to the plugin's setting, else true. */
  couponsEnabled?: boolean
  /** Credit ledger on (`features.credits`). Defaults to the plugin's setting, else true. */
  creditsEnabled?: boolean
  isOrganisationOwner?: OrganisationOwnerCheck
  purchaseRights?: PurchaseRightsCheck
  /** The plug-point registry. Defaults to the plugin's, else core's payment providers only. */
  registry?: PayloadJobsRegistry
  settingsSlug?: string
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
  tenantsSlug?: string
}

type PluginCustom = {
  features?: { coupons?: boolean; credits?: boolean }
  registry?: PayloadJobsRegistry
  slugs?: PayloadJobsCollectionSlugs & { tenants?: string }
  tenancy?: 'multi' | 'single'
}

type Resolved = Required<Omit<CheckoutOptions, 'registry'>> & { registry: PayloadJobsRegistry }

const resolveCheckoutOptions = (payload: Payload, options: CheckoutOptions = {}): Resolved => {
  const custom = ((payload.config?.custom as { payloadJobs?: PluginCustom } | undefined)?.payloadJobs ?? {}) as PluginCustom
  const tenantScoped = options.tenantScoped ?? (custom.tenancy ? custom.tenancy === 'multi' : true)
  const slugs = options.slugs ?? custom.registry?.context.slugs ?? custom.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const tenantsSlug = options.tenantsSlug ?? custom.registry?.context.tenantsSlug ?? custom.slugs?.tenants ?? 'tenants'
  const settingsSlug = options.settingsSlug ?? custom.registry?.context.settingsSlug ?? 'job-board-settings'
  return {
    couponsEnabled: options.couponsEnabled ?? custom.features?.coupons ?? true,
    creditsEnabled: options.creditsEnabled ?? custom.features?.credits ?? true,
    isOrganisationOwner: options.isOrganisationOwner ?? isOrganisationOwnerByRole,
    purchaseRights: options.purchaseRights ?? defaultPurchaseRights,
    registry:
      options.registry ??
      custom.registry ??
      createPayloadJobsRegistry({ settingsSlug, slugs, tenancy: tenantScoped ? 'multi' : 'single', tenantsSlug }),
    settingsSlug,
    slugs,
    tenantScoped,
    tenantsSlug,
  }
}

// ---------------------------------------------------------------------------------------------
// Database helpers

const sameID = (a: unknown, b: unknown): boolean => a !== null && b !== null && a !== undefined && b !== undefined && String(a) === String(b)

const has = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload.collections as Record<string, unknown> | undefined)?.[slug])

const findOne = async (req: PayloadRequest, collection: string, id: ID): Promise<Doc | null> =>
  (await req.payload.findByID({
    collection: collection as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id,
    overrideAccess: true,
    req,
  })) as Doc | null

/** Run `fn` with `flag` set on `req.context`, restoring what was there. */
const withContext = async <T>(req: PayloadRequest, flag: string, fn: () => Promise<T>): Promise<T> => {
  const had = Object.prototype.hasOwnProperty.call(req.context ?? {}, flag)
  const previous = req.context?.[flag]
  req.context = { ...req.context, [flag]: true }
  try {
    return await fn()
  } finally {
    if (had) req.context[flag] = previous
    else delete req.context[flag]
  }
}

/** Namespace of the coupon advisory lock ("PJ31"). The organisation lock is credits' own. */
export const COUPON_LOCK_NAMESPACE = 0x504a3331

/**
 * Hold a coupon's lock for the rest of the transaction, so two organisations can't both take the
 * last use of a limited coupon. Always taken after the organisation lock, never before.
 */
const lockCoupon = async (req: PayloadRequest, couponID: ID): Promise<void> => {
  const db = req.payload.db as unknown as {
    execute?: (args: { db: unknown; raw: string }) => Promise<unknown>
    sessions?: Record<string, { db?: unknown } | undefined>
  }
  const transactionID = await req.transactionID
  const session = transactionID === undefined || transactionID === null ? undefined : db.sessions?.[String(transactionID)]?.db
  if (!session || typeof db.execute !== 'function') {
    throw new Error('Checkout needs a Postgres database transaction')
  }
  // FNV-1a of the id: an integer computed here, so the statement carries no outside text.
  let hash = 0x811c9dc5
  for (const char of String(couponID)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193)
  }
  await db.execute({ db: session, raw: `SELECT pg_advisory_xact_lock(${COUPON_LOCK_NAMESPACE}, ${hash | 0})` })
}

type TenantDoc = TenantTaxSource & TenantPackCreditSource & { addOns?: unknown; currency?: unknown; id?: ID; timezone?: unknown }

const loadTenant = async (req: PayloadRequest, options: Resolved, tenantID: ID | null): Promise<TenantDoc> => {
  if (options.tenantScoped) {
    const tenant = tenantID === null ? null : await findOne(req, options.tenantsSlug, tenantID)
    if (!tenant) throw new CheckoutError('not_found', 'Unknown tenant')
    return tenant as TenantDoc
  }
  return (await req.payload.findGlobal({
    depth: 0,
    overrideAccess: true,
    req,
    slug: options.settingsSlug as GlobalSlug,
  })) as TenantDoc
}

// ---------------------------------------------------------------------------------------------
// Checkout

export type CheckoutJobArgs = {
  input: CheckoutInput
  options?: CheckoutOptions
  payload: Payload
  /** The caller's request; its user is the buyer and is stamped on every row written. */
  req: PayloadRequest
  /** The tenant the request is for (the site key's). Null in single-tenant mode. */
  tenantID: ID | null
  /**
   * The signed-in user, freshly read. Defaults to `req.user`. Null only for system code (an
   * import, a script), which acts as a site manager.
   */
  user?: MissionControlUser | null
}

export type CheckoutOrderSummary = {
  currency: string
  discount: number
  id: ID
  paymentMethod: OrderPaymentMethod
  paymentProvider: null | string
  /** The provider's reference (e.g. the invoice number), when it gave one. */
  reference: null | string
  status: OrderStatus
  subtotal: number
  tax: number
  total: number
}

export type CheckoutResult = {
  /** False when this repeats a checkout that already happened: nothing was written. */
  created: boolean
  credits: { balance: null | number; granted: number; used: number }
  job: { expiresAt: null | string; id: ID; plan: ID | null; status: string }
  order: CheckoutOrderSummary
  /** The order needs the organisation owner's approval before it is invoiced. */
  waitingForPurchase: boolean
}

export type CheckoutPreview = {
  /** What checkout would charge, and how. Nothing is written. */
  needsApproval: boolean
  paymentMethod: OrderPaymentMethod
  quote: Quote
}

type Prepared = {
  actor: OrderActor
  job: Doc
  organisationID: ID
  rights: PurchaseRights
  tenant: TenantDoc
  tenantID: ID | null
  user: MissionControlUser | null
}

/** Who may check this job out, and with what rights. */
const prepare = async (
  req: PayloadRequest,
  options: Resolved,
  jobID: ID,
  tenantID: ID | null,
  user: MissionControlUser | null,
): Promise<Prepared> => {
  if (!has(req, options.slugs.jobs)) throw new CheckoutError('not_found', 'Job not found')
  const job = await findOne(req, options.slugs.jobs, jobID)
  const jobTenant = options.tenantScoped ? tenantIDOf(job?.tenant) : null
  if (!job || (options.tenantScoped && !sameID(jobTenant, tenantID))) {
    throw new CheckoutError('not_found', 'Job not found')
  }
  const organisationID = tenantIDOf(job.organisation)
  if (organisationID === null) throw new CheckoutError('not_found', 'Job not found')

  const actor = await withoutSystemFlag(req, () =>
    orderActorFor({
      isOrganisationOwner: options.isOrganisationOwner,
      organisationID,
      req,
      tenantID: jobTenant,
      tenantScoped: options.tenantScoped,
    }),
  )

  if (user && actor !== 'staff') {
    // A member or owner must belong to the job's organisation, as an employer of its tenant.
    const role = options.tenantScoped ? getTenantRole(user, jobTenant as ID) : 'employer'
    if (role !== 'employer' || !sameID(getUserOrganisationID(user), organisationID)) {
      throw new CheckoutError('not_found', 'Job not found')
    }
  }

  const rights = await options.purchaseRights({ actor, organisationID, req, user })
  const tenant = await loadTenant(req, options, jobTenant)
  return { actor, job, organisationID, rights, tenant, tenantID: jobTenant, user }
}

/** `orderActorFor` reads the system flag first; work out the real actor without it. */
const withoutSystemFlag = async <T>(req: PayloadRequest, fn: () => Promise<T>): Promise<T> => {
  const had = Object.prototype.hasOwnProperty.call(req.context ?? {}, ORDER_SYSTEM_CONTEXT)
  const previous = req.context?.[ORDER_SYSTEM_CONTEXT]
  if (had) delete req.context[ORDER_SYSTEM_CONTEXT]
  try {
    return await fn()
  } finally {
    if (had) req.context[ORDER_SYSTEM_CONTEXT] = previous
  }
}

/** The service may be called without `parseCheckoutInput`; normalise what it compares. */
const normaliseInput = (input: CheckoutInput): CheckoutInput => ({
  ...input,
  addOnIds: input.addOnIds ?? [],
  closeDate: input.closeDate ?? null,
  couponCode: typeof input.couponCode === 'string' ? normalizeCouponCode(input.couponCode) || null : null,
  useCredit: input.useCredit === true,
})

const pricingCode = (error: PricingError): string => error.code.replace(/-/g, '_')

/** Load everything `quote()` needs from the database and price the purchase. */
const priceCheckout = async (
  req: PayloadRequest,
  options: Resolved,
  prepared: Prepared,
  input: CheckoutInput,
  { lockCouponRow }: { lockCouponRow: boolean },
): Promise<{ coupon: Doc | null; quoted: Quote }> => {
  const { job, organisationID, rights, tenant, tenantID } = prepared
  const inTenant = (doc: Doc | null): doc is Doc =>
    Boolean(doc) && (!options.tenantScoped || sameID(tenantIDOf(doc?.tenant), tenantID))

  const plan = await findOne(req, options.slugs.plans, input.planId)
  if (!inTenant(plan)) throw new CheckoutError('not_found', 'Plan not found')

  const { docs: catalog } = await req.payload.find({
    collection: options.slugs.addOns as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: options.tenantScoped ? { tenant: { equals: tenantID } } : {},
  })
  const addOns: Doc[] = []
  for (const id of input.addOnIds) {
    const addOn = (catalog as unknown as Doc[]).find((doc) => sameID(doc.id, id))
    if (!addOn) throw new CheckoutError('not_found', `Add-on ${String(id)} not found`)
    addOns.push(addOn)
  }

  let coupon: Doc | null = null
  if (input.couponCode !== null) {
    if (!options.couponsEnabled || !has(req, options.slugs.coupons)) {
      throw new CheckoutError('coupon_invalid', 'Coupons are not available', { reason: 'unknown' })
    }
    const { docs } = await req.payload.find({
      collection: options.slugs.coupons as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      req,
      where: {
        and: [{ code: { equals: input.couponCode } }, ...(options.tenantScoped ? [{ tenant: { equals: tenantID } }] : [])],
      },
    })
    coupon = (docs[0] as unknown as Doc | undefined) ?? null
    if (!coupon) throw new CheckoutError('coupon_invalid', 'That coupon code is not valid', { reason: 'unknown' })
    if (lockCouponRow) {
      await lockCoupon(req, coupon.id)
      coupon = await findOne(req, options.slugs.coupons, coupon.id)
      if (!coupon) throw new CheckoutError('coupon_invalid', 'That coupon code is not valid', { reason: 'unknown' })
    }
  }

  let availableCredits = 0
  if (input.useCredit) {
    if (!rights.useCredits) {
      throw new CheckoutError('forbidden', 'The organisation owner has not allowed you to use credits')
    }
    if (options.creditsEnabled && has(req, options.slugs.creditLedger)) {
      availableCredits = Math.max(
        0,
        await balanceFor({ organisation: organisationID, payload: req.payload, req, slug: options.slugs.creditLedger }),
      )
    }
  }

  const typeID = tenantIDOf(job.jobType)
  const type = typeID === null || !has(req, options.slugs.jobTypes) ? null : await findOne(req, options.slugs.jobTypes, typeID)
  const quoteJob: QuoteJob = {
    categories: idsOf([job.categories].flat()),
    type: type ? { id: type.id, isVolunteer: type.isVolunteer === true } : typeID,
  }

  let quoted: Quote
  try {
    quoted = quote({
      addOnCatalog: catalog as unknown as QuotableAddOn[],
      addOns: addOns as unknown as QuotableAddOn[],
      availableCredits,
      coupon: coupon as unknown as QuoteCouponTerms | null,
      currency: typeof tenant.currency === 'string' ? tenant.currency : undefined,
      job: quoteJob,
      plan: plan as unknown as QuotablePlan,
      tax: tenantTaxSettings(tenant),
    })
  } catch (error) {
    if (error instanceof PricingError) {
      throw new CheckoutError('pricing_error', error.message, { pricing: pricingCode(error) })
    }
    throw error
  }

  if (coupon) {
    if (!quoted.coupon?.applied) {
      throw new CheckoutError('coupon_invalid', 'That coupon can’t be used', { reason: quoted.coupon?.reason ?? 'unknown' })
    }
    if (quoted.coupon.discount === 0) {
      throw new CheckoutError('coupon_invalid', 'There is nothing left for this coupon to discount', { reason: 'nothing-to-discount' })
    }
  }

  // Add-on checkout steps (PJ-115) see the priced cart and may refuse it by throwing. They may
  // not change the money: an order's money must match its quote, and prices come from data.
  const context: CheckoutContext = {
    currency: quoted.currency,
    jobID: job.id,
    lines: quoted.lines.map((line) => ({ amount: line.amount, description: line.name, key: String(line.ref.key ?? line.ref.id) })),
    organisationID,
    payload: req.payload,
    planID: plan.id,
    req,
    tenantID,
    total: quoted.total,
  }
  const after = await runSteps(options.registry, context, prepared.tenant)
  if (
    after.total !== quoted.total ||
    after.currency !== quoted.currency ||
    after.lines.length !== context.lines.length ||
    after.lines.some((line, index) => line.amount !== context.lines[index].amount)
  ) {
    throw new Error('payload-jobs: a checkout step changed the price; steps may only refuse a checkout')
  }

  return { coupon, quoted }
}

const runSteps = async (registry: PayloadJobsRegistry, context: CheckoutContext, tenant: TenantDoc): Promise<CheckoutContext> => {
  let current = context
  for (const step of forTenant(registry, registry.checkoutSteps, tenant)) {
    if (await step.applies(current)) current = await step.run(current)
  }
  return current
}

/**
 * A pack whose credits only become usable once its order is paid is not "sold" yet: the job bought
 * with it then follows its own payment rule, as the old site did (PJ-120). Only a site that grants
 * on invoice gets the pack's credits, and one of them for the job, in the same breath.
 */
export const packCreditsApplyAtCheckout = (mode: PackCreditMode, status: OrderStatus): boolean =>
  packCreditGrantProblem({ mode, status }) === null

/** How a quote is settled: a credit paid it all, it costs nothing, or it is invoiced. */
export const paymentMethodFor = (quoted: Pick<Quote, 'credits' | 'total'>): OrderPaymentMethod =>
  quoted.total > 0 ? 'invoice' : quoted.credits.used > 0 ? 'credit' : 'free'

/** True when this purchase needs the buyer to be allowed to buy (it will be invoiced). */
const needsBuyRight = (quoted: Pick<Quote, 'total'>): boolean => quoted.total > 0

const OPEN_ORDER: (status: unknown) => boolean = (status) => status !== 'cancelled' && status !== 'failed'

const summary = (order: Doc, reference: null | string = null): CheckoutOrderSummary => ({
  currency: String(order.currency),
  discount: order.discount as number,
  id: order.id,
  paymentMethod: order.paymentMethod as OrderPaymentMethod,
  paymentProvider: (order.paymentProvider as null | string | undefined) ?? null,
  reference,
  status: order.status as OrderStatus,
  subtotal: order.subtotal as number,
  tax: order.tax as number,
  total: order.total as number,
})

const jobSummary = (job: Doc): CheckoutResult['job'] => ({
  expiresAt: (job.expiresAt as null | string | undefined) ?? null,
  id: job.id,
  plan: tenantIDOf(job.plan),
  status: String(job.status),
})

/** True when `order` was bought with the same plan, add-ons and coupon as `input`. */
const sameRequest = (order: Doc, input: CheckoutInput): boolean => {
  const bought = (Array.isArray(order.addOns) ? order.addOns : [])
    .filter((row) => row && typeof row === 'object' && (row as { included?: unknown }).included !== true)
    .map((row) => String(tenantIDOf((row as { addOn?: unknown }).addOn)))
  const asked = input.addOnIds.map(String)
  return (
    sameID(tenantIDOf(order.plan), input.planId) &&
    bought.length === asked.length &&
    asked.every((id) => bought.includes(id)) &&
    ((order.couponCode as null | string | undefined) ?? null) === input.couponCode
  )
}

/** Price a checkout without writing anything (for the UI's summary). */
export const previewCheckout = async (args: CheckoutJobArgs): Promise<CheckoutPreview> => {
  const options = resolveCheckoutOptions(args.payload, args.options)
  const user = args.user === undefined ? ((args.req.user as MissionControlUser | null) ?? null) : args.user
  const input = normaliseInput(args.input)
  const prepared = await prepare(args.req, options, input.jobId, args.tenantID, user)
  const { quoted } = await priceCheckout(args.req, options, prepared, input, { lockCouponRow: false })
  return {
    needsApproval: needsBuyRight(quoted) && !prepared.rights.buy,
    paymentMethod: paymentMethodFor(quoted),
    quote: quoted,
  }
}

/**
 * A request of checkout's own for the caller's user, so checkout always opens, and commits, its
 * own transaction: order events can then wait until the money is really committed. A caller's
 * transaction is not joined; checkout's writes commit on their own.
 */
const isolatedRequest = async (req: PayloadRequest): Promise<PayloadRequest> =>
  createPayloadRequest({
    context: { ...req.context, [ORDER_EVENTS_DEFER_CONTEXT]: [] },
    payload: req.payload,
    user: (req.user ?? null) as never,
  })

/**
 * Run `fn` in the request's own transaction under the organisation's lock, then (only once it
 * has committed) tell the invoice-sync adapters what happened to its orders. Adapters' durable
 * work (`InvoiceSyncAdapter.queue`) was queued inside the transaction, so a rollback leaves no
 * invoice, draft or job behind, and a crash after the commit is made up by the queued work.
 */
const committed = async <T>(req: PayloadRequest, options: Resolved, organisationID: ID, fn: () => Promise<T>): Promise<T> => {
  if (await req.transactionID) throw new Error('payload-jobs: checkout must run in a transaction of its own')
  const result = await withOrganisationCreditLock(req, organisationID, fn)
  const events = (req.context[ORDER_EVENTS_DEFER_CONTEXT] as DeferredOrderEvent[] | undefined) ?? []
  req.context[ORDER_EVENTS_DEFER_CONTEXT] = []
  await emitDeferredOrderEvents(options.registry, req.payload, events)
  return result
}

/**
 * Check a job out: price it, create its order, take or grant credits and start the payment, in
 * one transaction. Safe to repeat: a second identical call returns the first order.
 */
export const checkoutJob = async (args: CheckoutJobArgs): Promise<CheckoutResult> => {
  await assertNotViewingAs(args.req, 'checkout')

  const req = await isolatedRequest(args.req)
  const input = normaliseInput(args.input)
  const options = resolveCheckoutOptions(args.payload, args.options)
  const user = args.user === undefined ? ((req.user as MissionControlUser | null) ?? null) : args.user

  // Access first (outside the lock), so a stranger learns nothing and holds no lock.
  const first = await prepare(req, options, input.jobId, args.tenantID, user)

  return committed(req, options, first.organisationID, async () => {
    // Re-read under the lock: a checkout that just committed is visible now.
    const prepared = await prepare(req, options, input.jobId, args.tenantID, user)
    const { job } = prepared
    if (!sameID(prepared.organisationID, first.organisationID)) {
      throw new CheckoutError('job_not_checkoutable', 'The job moved to another organisation; try again')
    }

    const currentID = tenantIDOf(job.order)
    const current = currentID === null ? null : await findOne(req, options.slugs.orders, currentID)
    if (current && OPEN_ORDER(current.status)) {
      if (!sameRequest(current, input)) {
        throw new CheckoutError('already_checked_out', 'This job already has an open order', { orderId: current.id })
      }
      return {
        created: false,
        credits: { balance: await balanceOrNull(req, options, prepared.organisationID), granted: 0, used: 0 },
        job: jobSummary(job),
        order: summary(current),
        waitingForPurchase: current.status === 'waiting_for_purchase',
      }
    }

    if (job.status !== 'draft' && job.status !== 'pending') {
      throw new CheckoutError(
        'job_not_checkoutable',
        job.status === 'expired' ? 'Relist the job to buy a new listing' : `A ${String(job.status)} job can’t be checked out`,
      )
    }

    const { quoted } = await priceCheckout(req, options, prepared, input, { lockCouponRow: true })

    let expiresAt: null | string = null
    if (input.closeDate !== null) {
      const timeZone = validTimeZone(prepared.tenant.timezone)
      const problem = closeDateProblem({
        closeDate: input.closeDate,
        durationDays: quoted.plan.durationDays,
        now: new Date(),
        timeZone,
      })
      if (problem) throw new CheckoutError('close_date_invalid', problem)
      expiresAt = endOfLocalDay(input.closeDate, timeZone)
    }

    const method = paymentMethodFor(quoted)
    const waiting = needsBuyRight(quoted) && !prepared.rights.buy
    const snapshot = snapshotQuote(quoted)

    const order = (await withContext(req, ORDER_SYSTEM_CONTEXT, () =>
      req.payload.create({
        collection: options.slugs.orders as CollectionSlug,
        data: {
          jobs: [job.id],
          organisation: prepared.organisationID,
          paymentMethod: method,
          paymentProvider: method === 'invoice' ? 'invoice' : null,
          quote: snapshot,
          status: waiting ? 'waiting_for_purchase' : 'pending',
          ...(options.tenantScoped ? { tenant: prepared.tenantID } : {}),
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      }),
    )) as unknown as Doc

    const updatedJob = (await req.payload.update({
      collection: options.slugs.jobs as CollectionSlug,
      data: {
        order: order.id,
        plan: input.planId,
        ...(job.status === 'draft' ? { status: 'pending' } : {}),
        // Null clears an earlier choice, so the plan's full duration applies.
        expiresAt,
      } as never,
      depth: 0,
      id: job.id,
      overrideAccess: true,
      req,
    })) as unknown as Doc

    if (waiting) {
      return {
        created: true,
        credits: { balance: await balanceOrNull(req, options, prepared.organisationID), granted: 0, used: 0 },
        job: jobSummary(updatedJob),
        order: summary(order),
        waitingForPurchase: true,
      }
    }

    const settled = await settleOrder(req, options, prepared, order, snapshot)
    return {
      created: true,
      credits: settled.credits,
      job: jobSummary(updatedJob),
      order: summary(settled.order, settled.reference),
      waitingForPurchase: false,
    }
  })
}

const balanceOrNull = async (req: PayloadRequest, options: Resolved, organisationID: ID): Promise<null | number> =>
  options.creditsEnabled && has(req, options.slugs.creditLedger)
    ? balanceFor({ organisation: organisationID, payload: req.payload, req, slug: options.slugs.creditLedger })
    : null

const creditError = (error: unknown): never => {
  if (error instanceof CreditLedgerError && error.code === 'insufficient-credits') {
    throw new CheckoutError('insufficient_credits', 'The organisation has no credit left')
  }
  throw error
}

/**
 * Settle a `pending` order: count the coupon use, take the credit, start the payment through
 * its provider, then grant a pack's credits and use one for the job. Runs inside the caller's
 * transaction and organisation lock; any failure rolls all of it back.
 */
const settleOrder = async (
  req: PayloadRequest,
  options: Resolved,
  prepared: Prepared,
  order: Doc,
  snapshot: QuoteSnapshot,
): Promise<{ credits: CheckoutResult['credits']; order: Doc; reference: null | string }> => {
  const jobID = idsOf([order.jobs].flat())[0] ?? null
  let used = 0
  let granted = 0

  // 1. The coupon: still usable, and its use counted, under its own lock.
  const couponID = snapshot.coupon?.applied ? (snapshot.coupon.id ?? null) : null
  if (couponID !== null && options.couponsEnabled && has(req, options.slugs.coupons)) {
    await lockCoupon(req, couponID)
    const coupon = await findOne(req, options.slugs.coupons, couponID)
    const useCount = (coupon?.useCount as null | number | undefined) ?? 0
    const maxUses = (coupon?.maxUses as null | number | undefined) ?? null
    if (!coupon || coupon.active === false || (maxUses !== null && useCount >= maxUses)) {
      throw new CheckoutError('coupon_unavailable', 'That coupon is no longer available')
    }
    await withContext(req, COUPON_USE_COUNT_CONTEXT, () =>
      req.payload.update({
        collection: options.slugs.coupons as CollectionSlug,
        context: { [COUPON_USE_COUNT_CONTEXT]: true },
        data: { useCount: useCount + 1 } as never,
        depth: 0,
        id: couponID as DocumentID,
        overrideAccess: true,
        req,
      }),
    )
  }

  // 2. A credit that pays the plan, recorded against this order (so a later listing of the same
  //    job is charged again rather than read as a repeat, PJ-24 follow-up).
  if (snapshot.credits.used > 0) {
    if (jobID === null) throw new Error('payload-jobs: a credit order must name its job')
    await consumeCredit({ job: jobID, order: order.id, payload: req.payload, req, slug: options.slugs.creditLedger }).catch(
      creditError,
    )
    used = 1
  }

  // 3. The payment, through the order's provider (PJ-115).
  const method = order.paymentMethod as OrderPaymentMethod
  const providerKey = method === 'invoice' ? String(order.paymentProvider ?? 'invoice') : method
  const provider = forTenant(options.registry, options.registry.paymentProviders, prepared.tenant).find(
    (entry) => entry.key === providerKey,
  )
  if (!provider || (provider.currencies !== '*' && !provider.currencies.includes(String(order.currency)))) {
    throw new CheckoutError('payment_failed', `Payment by ${providerKey} is not available`)
  }
  const payment: PaymentResult = await provider.createPayment({
    amount: order.total as number,
    currency: String(order.currency),
    orderID: order.id,
    payload: req.payload,
    req,
    tenantID: prepared.tenantID,
  })
  if (payment.status === 'failed') throw new CheckoutError('payment_failed', 'The payment did not go through')
  const status: OrderStatus = payment.status === 'paid' ? 'paid' : 'invoiced'

  const settled = (await withContext(req, ORDER_SYSTEM_CONTEXT, () =>
    req.payload.update({
      collection: options.slugs.orders as CollectionSlug,
      data: { status } as never,
      depth: 0,
      id: order.id,
      overrideAccess: true,
      req,
    }),
  )) as unknown as Doc

  // 4. A pack: its credits go into the ledger, and one pays for this job (PJ-120). A site that
  //    grants on payment waits for the order to be paid; the orders hook grants them then.
  const packMode = tenantPackCreditMode(prepared.tenant)
  if (
    snapshot.plan.jobCredits > 1 &&
    snapshot.entitlements.jobCreditsGranted > 0 &&
    options.creditsEnabled &&
    packCreditsApplyAtCheckout(packMode, status)
  ) {
    const grant = await grantCredits({
      order: order.id,
      packCreditMode: packMode,
      payload: req.payload,
      req,
      slug: options.slugs.creditLedger,
    })
    granted = grant.entry.delta
    if (jobID !== null) {
      await consumeCredit({ job: jobID, order: order.id, payload: req.payload, req, slug: options.slugs.creditLedger }).catch(
        creditError,
      )
      used += 1
    }
  }

  return {
    credits: { balance: await balanceOrNull(req, options, prepared.organisationID), granted, used },
    order: settled,
    reference: payment.reference ?? null,
  }
}

// ---------------------------------------------------------------------------------------------
// Purchase requests

/**
 * A purchase request is priced when the member asks; by the time the owner approves, its coupon
 * may be used up or the credit it counted on spent. Refuse then, before writing anything.
 */
const assertStillSettleable = async (req: PayloadRequest, options: Resolved, prepared: Prepared, snapshot: QuoteSnapshot): Promise<void> => {
  const retry = 'Decline this request and submit the job again to get a new price.'
  const couponID = snapshot.coupon?.applied ? (snapshot.coupon.id ?? null) : null
  if (couponID !== null && options.couponsEnabled && has(req, options.slugs.coupons)) {
    await lockCoupon(req, couponID)
    const coupon = await findOne(req, options.slugs.coupons, couponID)
    const useCount = (coupon?.useCount as null | number | undefined) ?? 0
    const maxUses = (coupon?.maxUses as null | number | undefined) ?? null
    if (!coupon || coupon.active === false || (maxUses !== null && useCount >= maxUses)) {
      throw new CheckoutError('coupon_unavailable', `The coupon on this request is no longer available. ${retry}`)
    }
  }
  if (snapshot.credits.used > 0) {
    const balance = (await balanceOrNull(req, options, prepared.organisationID)) ?? 0
    if (balance < snapshot.credits.used) {
      throw new CheckoutError('insufficient_credits', `The organisation has no credit left for this request. ${retry}`)
    }
  }
}

export type PurchaseDecisionArgs = {
  options?: CheckoutOptions
  orderId: ID
  payload: Payload
  req: PayloadRequest
  tenantID: ID | null
  user?: MissionControlUser | null
}

/** Load a purchase request for its owner or a site manager; anyone else gets `not_found`. */
const preparePurchase = async (req: PayloadRequest, options: Resolved, args: PurchaseDecisionArgs, user: MissionControlUser | null) => {
  const order = await findOne(req, options.slugs.orders, args.orderId)
  if (!order || (options.tenantScoped && !sameID(tenantIDOf(order.tenant), args.tenantID))) {
    throw new CheckoutError('not_found', 'Order not found')
  }
  const jobID = idsOf([order.jobs].flat())[0] ?? null
  if (jobID === null) throw new CheckoutError('not_found', 'Order not found')
  const prepared = await prepare(req, options, jobID, args.tenantID, user)
  if (!sameID(prepared.organisationID, order.organisation)) throw new CheckoutError('not_found', 'Order not found')
  if (prepared.actor === 'member') {
    throw new CheckoutError('forbidden', 'Only the organisation owner or a site manager can answer a purchase request')
  }
  return { order, prepared }
}

/**
 * The owner (or a site manager) approves a member's purchase request: the order is invoiced (or
 * paid) exactly as an immediate checkout would have been. Repeating it returns the result.
 */
export const approvePurchase = async (args: PurchaseDecisionArgs): Promise<CheckoutResult> => {
  await assertNotViewingAs(args.req, 'checkout.approve')

  const req = await isolatedRequest(args.req)
  const options = resolveCheckoutOptions(args.payload, args.options)
  const user = args.user === undefined ? ((req.user as MissionControlUser | null) ?? null) : args.user
  const first = await preparePurchase(req, options, args, user)

  return committed(req, options, first.prepared.organisationID, async () => {
    const { order, prepared } = await preparePurchase(req, options, args, user)
    const job = prepared.job

    if (order.status !== 'waiting_for_purchase') {
      if (order.status === 'invoiced' || order.status === 'paid') {
        return {
          created: false,
          credits: { balance: await balanceOrNull(req, options, prepared.organisationID), granted: 0, used: 0 },
          job: jobSummary(job),
          order: summary(order),
          waitingForPurchase: false,
        }
      }
      throw new CheckoutError('order_not_waiting', `This order is ${String(order.status)}, not waiting for approval`)
    }
    if (!sameID(tenantIDOf(job.order), order.id) || job.status === 'cancelled') {
      throw new CheckoutError('order_not_waiting', 'This order no longer pays for its job')
    }

    // What could fail while settling is checked before anything is written, with a clear way out.
    await assertStillSettleable(req, options, prepared, order.quote as QuoteSnapshot)

    const pending = (await withContext(req, ORDER_SYSTEM_CONTEXT, () =>
      req.payload.update({
        collection: options.slugs.orders as CollectionSlug,
        data: { status: 'pending', statusNote: 'Purchase approved' } as never,
        depth: 0,
        id: order.id,
        overrideAccess: true,
        req,
      }),
    )) as unknown as Doc

    const settled = await settleOrder(req, options, prepared, pending, pending.quote as QuoteSnapshot)
    return {
      created: true,
      credits: settled.credits,
      job: jobSummary(job),
      order: summary(settled.order, settled.reference),
      waitingForPurchase: false,
    }
  })
}

/** The owner (or a site manager) declines a purchase request: the order is cancelled. */
export const declinePurchase = async (args: PurchaseDecisionArgs): Promise<CheckoutOrderSummary> => {
  await assertNotViewingAs(args.req, 'checkout.decline')

  const req = await isolatedRequest(args.req)
  const options = resolveCheckoutOptions(args.payload, args.options)
  const user = args.user === undefined ? ((req.user as MissionControlUser | null) ?? null) : args.user
  const first = await preparePurchase(req, options, args, user)

  return committed(req, options, first.prepared.organisationID, async () => {
    const { order } = await preparePurchase(req, options, args, user)
    if (order.status === 'cancelled') return summary(order)
    if (order.status !== 'waiting_for_purchase') {
      throw new CheckoutError('order_not_waiting', `This order is ${String(order.status)}, not waiting for approval`)
    }
    const cancelled = (await withContext(req, ORDER_SYSTEM_CONTEXT, () =>
      req.payload.update({
        collection: options.slugs.orders as CollectionSlug,
        data: { status: 'cancelled', statusNote: 'Purchase declined' } as never,
        depth: 0,
        id: order.id,
        overrideAccess: true,
        req,
      }),
    )) as unknown as Doc
    return summary(cancelled)
  })
}

// ---------------------------------------------------------------------------------------------
// Account endpoints (PJ-81 pattern)

export type CheckoutEndpointOptions = CheckoutOptions & Pick<AccountAuthOptions, 'rateLimiter' | 'usersSlug'>

const errorResponse = (error: CheckoutError): Response =>
  accountResponse({ error: { code: error.code, message: error.message, ...error.detail } }, error.status)

const readJSON = async (req: PayloadRequest): Promise<unknown> => {
  try {
    return await req.json?.()
  } catch {
    throw new CheckoutError('invalid_request', 'The request body is not valid JSON')
  }
}

const accountEndpoint = (
  options: CheckoutEndpointOptions,
  path: string,
  handler: (args: { req: PayloadRequest; tenant: AccountTenant; user: MissionControlUser }) => Promise<Response>,
): Endpoint => ({
  handler: async (req) => {
    try {
      const tenant = await resolveAccountTenant(req, { tenantsSlug: options.tenantsSlug ?? 'tenants' })
      const user = await resolveAccountUser(req, tenant, { usersSlug: options.usersSlug })
      if (!user) throw new AccountAuthError({ code: 'not_authenticated', message: 'Not signed in.', status: 401 })
      await enforceRateLimit({ action: 'checkout', identifier: String(user.id), options: { rateLimiter: options.rateLimiter }, req, tenant })
      return await handler({ req, tenant, user })
    } catch (error) {
      if (error instanceof CheckoutError) return errorResponse(error)
      if (error instanceof AccountAuthError) {
        return accountResponse({ error: { code: error.code, message: error.message } }, error.status, error.headers)
      }
      // A view-as guard rail (assertNotViewingAs) refused the checkout.
      if (error instanceof Forbidden) {
        return accountResponse(
          { error: { code: 'view_as_blocked', message: 'This is not available while viewing the site as a user.' } },
          403,
        )
      }
      req.payload.logger.error({ err: error, msg: `checkout: ${path} failed` })
      return accountResponse({ error: { code: 'server_error', message: 'Something went wrong.' } }, 500)
    }
  },
  method: 'post',
  path: `/:slug/account/${path}`,
})

const orderID = (req: PayloadRequest): ID => {
  const id = req.routeParams?.id
  if (!isID(id)) throw new CheckoutError('invalid_request', 'Order id is required')
  return id
}

/**
 * Checkout endpoints for the /account dashboard, under the tenants collection like the account
 * auth endpoints (`/api/tenants/:slug/account/...`): site key + the user's bearer token.
 *
 * - `checkout/quote`: price a checkout, write nothing.
 * - `checkout`: check a job out (201, or 200 when it repeats an earlier checkout).
 * - `orders/:id/approve`, `orders/:id/decline`: the owner answers a purchase request.
 */
export const accountCheckoutEndpoints = (options: CheckoutEndpointOptions = {}): Endpoint[] => {
  const service = (tenant: AccountTenant, req: PayloadRequest, user: MissionControlUser) => ({
    options,
    payload: req.payload,
    req,
    tenantID: tenant.id,
    user,
  })

  return [
    accountEndpoint(options, 'checkout/quote', async ({ req, tenant, user }) => {
      const input = parseCheckoutInput(await readJSON(req))
      return accountResponse(await previewCheckout({ ...service(tenant, req, user), input }))
    }),
    accountEndpoint(options, 'checkout', async ({ req, tenant, user }) => {
      const input = parseCheckoutInput(await readJSON(req))
      const result = await checkoutJob({ ...service(tenant, req, user), input })
      return accountResponse(result, result.created ? 201 : 200)
    }),
    accountEndpoint(options, 'orders/:id/approve', async ({ req, tenant, user }) =>
      accountResponse(await approvePurchase({ ...service(tenant, req, user), orderId: orderID(req) })),
    ),
    accountEndpoint(options, 'orders/:id/decline', async ({ req, tenant, user }) =>
      accountResponse({ order: await declinePurchase({ ...service(tenant, req, user), orderId: orderID(req) }) }),
    ),
  ]
}
