import {
  ValidationError,
  type Access,
  type AccessResult,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
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
  hasTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type TenantRole,
} from './access'
import { idsOf, resultingTenantID, tenantIDOf } from './catalog'
import { validateUrl } from './collections/organisations'
import { isMinorUnits } from './money'
import {
  isRegisteredPaymentProvider,
  ORDER_PAYMENT_METHOD_LABELS,
  ORDER_PAYMENT_METHODS,
  resolvePaymentProviders,
  type OrderPaymentMethod,
  type PaymentProviderDefinition,
} from './payment-providers'
import { QUOTE_SNAPSHOT_VERSION } from './pricing'
import {
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  mergeCollectionAccess,
  type CollectionAccess,
  type PayloadJobsCollectionSlugs,
} from './slugs'

/**
 * Orders (PJ-23). An order belongs to an organisation in one tenant, never to the person who
 * placed it (`createdBy`, which Payload stamps, records who that was). It keeps a frozen copy of
 * what was sold — the quote (`pricing.ts`), the add-ons, the tax lines — and its money in whole
 * minor units of one currency. Once created, none of that changes.
 *
 * Its status moves along `ORDER_TRANSITIONS`, and every move lands in the append-only `log`.
 * Members of the organisation read its orders; only site managers (tenant admins), the
 * organisation's owner (for a purchase request) and system code change them. Nobody deletes one.
 *
 * Out of scope here: checkout (PJ-31) creates orders, the credit ledger (PJ-24) and the Xero
 * add-on (PJ-57, which stores its invoice under `externalRefs`).
 */

export const ORDERS_SLUG = 'orders'

export const ORDER_STATUSES = [
  'waiting_for_purchase',
  'pending',
  'invoiced',
  'paid',
  'cancelled',
  'failed',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  cancelled: 'Cancelled',
  failed: 'Failed',
  invoiced: 'Invoiced',
  paid: 'Paid',
  pending: 'Pending',
  waiting_for_purchase: 'Waiting for purchase',
}

export const isOrderStatus = (value: unknown): value is OrderStatus =>
  typeof value === 'string' && (ORDER_STATUSES as readonly string[]).includes(value)

/**
 * WordPress (JobRoller) transaction statuses and the order status each imports as (PJ-65). A
 * legacy `tr_pending` is a bank transfer nobody marked complete: the organisation was invoiced,
 * so it imports as `invoiced`, not as unpaid-and-waiting. `tr_completed` (paid) and
 * `tr_activated` (paid and the listing released) are both paid.
 */
export const LEGACY_ORDER_STATUSES: Readonly<Record<string, OrderStatus>> = Object.freeze({
  tr_activated: 'paid',
  tr_completed: 'paid',
  tr_failed: 'failed',
  tr_pending: 'invoiced',
})

/** The order status for a WordPress transaction status, or `null` for one the import doesn't know. */
export const orderStatusFromLegacy = (status: unknown): null | OrderStatus =>
  typeof status === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_ORDER_STATUSES, status)
    ? LEGACY_ORDER_STATUSES[status]
    : null

/**
 * Where each status may go. `paid` and `cancelled` are final: a paid order is never reopened
 * (refunds are a later ticket), and a cancelled one stays cancelled. `failed` (an imported card
 * payment that never went through) can only be closed.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  cancelled: [],
  failed: ['cancelled'],
  invoiced: ['paid', 'cancelled'],
  paid: [],
  pending: ['invoiced', 'paid', 'cancelled', 'failed'],
  waiting_for_purchase: ['pending', 'invoiced', 'cancelled'],
}

/**
 * What an organisation owner may do: answer a member's purchase request. Approving moves it to
 * `pending` (checkout then invoices it); declining cancels it. Everything else is the site
 * manager's or system code's.
 */
export const ORDER_OWNER_TRANSITIONS: Readonly<Partial<Record<OrderStatus, readonly OrderStatus[]>>> = {
  waiting_for_purchase: ['pending', 'cancelled'],
}

/** Site managers: orders are money, so tenant admins only (as for coupons and billing terms). */
export const ORDER_STAFF_ROLES = ['tenant-admin'] as const satisfies readonly TenantRole[]

/** Members of an organisation, who read its orders. */
export const ORDER_MEMBER_ROLES = ['employer'] as const satisfies readonly TenantRole[]

/** Who is acting on an order. `member` reads only. */
export type OrderActor = 'member' | 'owner' | 'staff' | 'system'

export const ORDER_ACTORS = ['system', 'staff', 'owner', 'member'] as const satisfies readonly OrderActor[]

export const ORDER_LOG_EVENTS = ['created', 'status', 'external-ref', 'jobs', 'organisation'] as const
export type OrderLogEvent = (typeof ORDER_LOG_EVENTS)[number]

/**
 * Set this on `req.context` when trusted code acts for a signed-in user under `overrideAccess`
 * (checkout invoicing a member's order, say). The order then treats the write as system code's.
 * A request without a user is already system code.
 */
export const ORDER_SYSTEM_CONTEXT = 'orderSystem'

/** The fields that are fixed once the order exists: what was sold, for how much, and how. */
export const ORDER_IMMUTABLE_FIELDS = [
  'addOns',
  'coupon',
  'couponCode',
  'currency',
  'discount',
  'paymentMethod',
  'plan',
  'quote',
  'subtotal',
  'tax',
  'taxInclusive',
  'taxLines',
  'total',
] as const

/** Fields only system code may change after create: merging organisations, re-keying an import. */
export const ORDER_SYSTEM_ONLY_FIELDS = ['organisation', 'paymentProvider', 'legacyId'] as const

/**
 * Whether `user` owns `organisationID`. Organisations have no owner role yet (PJ-29 adds the
 * owner and members); until a host passes this, no one is an owner and site managers answer
 * purchase requests.
 */
export type OrganisationOwnerCheck = (args: {
  organisationID: number | string
  req: PayloadRequest
  user: MissionControlUser
}) => boolean | Promise<boolean>

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const hasCollection = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload?.collections as Record<string, unknown> | undefined)?.[slug])

const sameID = (a: unknown, b: unknown): boolean => a !== null && b !== null && String(a) === String(b)

const combine = (scopes: (null | Where)[]): AccessResult => {
  const present = scopes.filter((scope): scope is Where => scope !== null)
  if (present.length === 0) return false
  return present.length === 1 ? present[0] : { or: present }
}

/** The orders of the user's own organisation, in the tenants where they are a member. */
const memberScope = (user: MissionControlUser, tenantScoped: boolean): null | Where => {
  const organisation = getUserOrganisationID(user)
  if (organisation === null) return null

  if (!tenantScoped) {
    return hasAnyTenantRole(user, ORDER_MEMBER_ROLES) ? { organisation: { equals: organisation } } : null
  }

  const tenants = getUserTenantIDsByRole(user, ORDER_MEMBER_ROLES)
  if (tenants.length === 0) return null

  return { and: [{ organisation: { equals: organisation } }, { tenant: { in: tenants } }] }
}

const staffScope = (user: MissionControlUser, tenantScoped: boolean): null | Where | true => {
  if (!tenantScoped) return hasAnyTenantRole(user, ORDER_STAFF_ROLES) ? true : null
  const tenants = getUserTenantIDsByRole(user, ORDER_STAFF_ROLES)
  return tenants.length > 0 ? { tenant: { in: tenants } } : null
}

const isStaffFor = (user: MissionControlUser, tenantID: null | number | string, tenantScoped: boolean): boolean => {
  if (isSuperAdmin(user)) return true
  if (!tenantScoped) return hasAnyTenantRole(user, ORDER_STAFF_ROLES)
  return tenantID !== null && hasTenantRole(user, tenantID, ORDER_STAFF_ROLES)
}

/** True when `user` is a member of `organisationID` in `tenantID`. */
const isMemberOf = (
  user: MissionControlUser,
  organisationID: null | number | string,
  tenantID: null | number | string,
  tenantScoped: boolean,
): boolean => {
  if (organisationID === null || !sameID(getUserOrganisationID(user), organisationID)) return false
  if (!tenantScoped) return hasAnyTenantRole(user, ORDER_MEMBER_ROLES)
  return tenantID !== null && hasTenantRole(user, tenantID, ORDER_MEMBER_ROLES)
}

/** Who is acting on an order of `organisationID` in `tenantID`. */
export const orderActorFor = async ({
  isOrganisationOwner,
  organisationID,
  req,
  tenantID,
  tenantScoped,
}: {
  isOrganisationOwner?: OrganisationOwnerCheck
  organisationID: null | number | string
  req: PayloadRequest
  tenantID: null | number | string
  tenantScoped: boolean
}): Promise<OrderActor> => {
  if (req.context?.[ORDER_SYSTEM_CONTEXT] === true) return 'system'

  const user = userOf(req)
  if (!user) return 'system'
  if (isStaffFor(user, tenantID, tenantScoped)) return 'staff'

  if (
    isOrganisationOwner &&
    organisationID !== null &&
    isMemberOf(user, organisationID, tenantID, tenantScoped) &&
    (await isOrganisationOwner({ organisationID, req, user }))
  ) {
    return 'owner'
  }

  return 'member'
}

/**
 * Read access.
 * - Super admins: every order. Tenant admins: every order in their tenants.
 * - Employers: their own organisation's orders, in the tenants where they are an employer.
 * - Editors, seekers, site keys and anonymous callers: nothing. Orders are never public.
 *
 * In multi-tenant mode the plugin also ANDs `tenant in <user's tenants>` onto a user's result.
 */
export const orderReadAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    const staff = staffScope(user, tenantScoped)
    if (staff === true) return true

    return combine([staff, memberScope(user, tenantScoped)])
  }

/**
 * Create: site managers, in the submitted tenant. Employers order through checkout (PJ-31),
 * which runs as system code. A `where` result doesn't filter create data, so the tenant is
 * checked here; a super admin must still name one.
 */
export const orderCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (!tenantScoped) return isSuperAdmin(user) || hasAnyTenantRole(user, ORDER_STAFF_ROLES)

    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    if (isSuperAdmin(user)) return true

    return hasTenantRole(user, submitted, ORDER_STAFF_ROLES)
  }

/**
 * Update: site managers in their tenants, and an organisation owner on their own organisation's
 * orders (when the host says who owns what). Field access narrows an owner to the status, and
 * `orderRules` to answering a purchase request. Members never write.
 */
export const orderUpdateAccess =
  (tenantScoped: boolean, isOrganisationOwner?: OrganisationOwnerCheck): Access =>
  async ({ data, req }) => {
    const user = userOf(req)
    if (!user || isSeekerOnly(user)) return false
    if (isSuperAdmin(user)) return true

    // Moving an order to another tenant is never a status change; the tenant must stay one the
    // user manages. `orderRules` refuses any tenant change outright.
    if (tenantScoped && data && Object.prototype.hasOwnProperty.call(data, 'tenant')) {
      const submitted = tenantIDOf((data as { tenant?: unknown }).tenant)
      if (submitted === null) return false
    }

    const staff = staffScope(user, tenantScoped)
    if (staff === true) return true

    let owner: null | Where = null
    const organisation = getUserOrganisationID(user)
    if (isOrganisationOwner && organisation !== null) {
      const scope = memberScope(user, tenantScoped)
      if (scope && (await isOrganisationOwner({ organisationID: organisation, req, user }))) owner = scope
    }

    return combine([staff, owner])
  }

/** Orders are accounting records: nobody deletes one. A host may override this per operation. */
export const orderDeleteAccess: Access = () => false

/**
 * Fields only site managers and system code write. Checked against the order's own tenant, so a
 * tenant admin of an unrelated tenant decides nothing here.
 */
export const orderStaffFieldAccess =
  (tenantScoped: boolean): FieldAccess =>
  ({ data, doc, req }) => {
    if (req.context?.[ORDER_SYSTEM_CONTEXT] === true) return true
    const user = userOf(req)
    if (!user) return true
    return isStaffFor(user, tenantIDOf(doc?.tenant ?? (data as { tenant?: unknown } | undefined)?.tenant), tenantScoped)
  }

/** The status (and its note): site managers, system code, and the organisation's owner. */
export const orderStatusFieldAccess =
  (tenantScoped: boolean, isOrganisationOwner?: OrganisationOwnerCheck): FieldAccess =>
  async ({ data, doc, req }) => {
    const source = (doc ?? data) as undefined | { organisation?: unknown; tenant?: unknown }
    const actor = await orderActorFor({
      isOrganisationOwner,
      organisationID: tenantIDOf(source?.organisation),
      req,
      tenantID: tenantIDOf(source?.tenant),
      tenantScoped,
    })
    return actor !== 'member'
  }

/** Nobody writes the log; `orderRules` appends to it. */
const noWrite: FieldAccess = () => false

/** Why `from` → `to` is not allowed for `actor`, or `null` when it is. */
export const orderTransitionProblem = (
  from: OrderStatus,
  to: OrderStatus,
  actor: OrderActor,
): null | string => {
  if (from === to) return null

  if (actor === 'member') return 'Only the organisation owner or a site manager can change an order'

  const allowed = actor === 'owner' ? (ORDER_OWNER_TRANSITIONS[from] ?? []) : ORDER_TRANSITIONS[from]
  if (allowed.includes(to)) return null

  if (actor === 'owner' && ORDER_TRANSITIONS[from].includes(to)) {
    return 'Only a site manager can make that change'
  }

  return `An order can’t go from ${ORDER_STATUS_LABELS[from]} to ${ORDER_STATUS_LABELS[to]}`
}

// ---------------------------------------------------------------------------------------------
// Money

export type OrderTaxLine = {
  gross: number
  key: string
  name: string
  net: number
  /** Basis points: 1500 is 15%. */
  rate: number
  tax: number
  xeroTaxType?: null | string
}

export type OrderAddOnLine = {
  addOn?: null | number | string
  amount: number
  durationDays: number
  included: boolean
  key?: null | string
  name: string
  placement?: null | string
  unitPrice: number
}

/** The money on an order. `total = subtotal − discount + (taxInclusive ? 0 : tax)`. */
export type OrderMoney = {
  currency: string
  discount: number
  subtotal: number
  tax: number
  taxInclusive: boolean
  taxLines: OrderTaxLine[]
  total: number
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Everything wrong with an order's money, as field errors. Empty when it adds up. */
export const orderMoneyProblems = (money: Partial<Record<keyof OrderMoney, unknown>>): { message: string; path: string }[] => {
  const errors: { message: string; path: string }[] = []

  if (typeof money.currency !== 'string' || !CURRENCY_PATTERN.test(money.currency)) {
    errors.push({ message: 'Use a three-letter ISO 4217 code, for example VUV', path: 'currency' })
  }

  for (const path of ['subtotal', 'discount', 'tax', 'total'] as const) {
    if (!isMinorUnits(money[path])) {
      errors.push({ message: 'Use a whole number of minor units, 0 or more', path })
    }
  }

  const lines: unknown = money.taxLines ?? []
  if (!Array.isArray(lines)) {
    errors.push({ message: 'Tax lines must be a list', path: 'taxLines' })
  } else {
    lines.forEach((line, index) => {
      const row = isRecord(line) ? line : {}
      for (const key of ['net', 'tax', 'gross', 'rate'] as const) {
        if (!isMinorUnits(row[key])) {
          errors.push({ message: 'Use a whole number, 0 or more', path: `taxLines.${index}.${key}` })
        }
      }
      if (isMinorUnits(row.net) && isMinorUnits(row.tax) && isMinorUnits(row.gross) && row.net + row.tax !== row.gross) {
        errors.push({ message: 'Net plus tax must equal gross', path: `taxLines.${index}.gross` })
      }
    })
  }

  if (errors.length > 0) return errors

  const subtotal = money.subtotal as number
  const discount = money.discount as number
  const tax = money.tax as number
  const total = money.total as number

  if (discount > subtotal) errors.push({ message: 'The discount can’t be more than the subtotal', path: 'discount' })

  const taxLines = lines as OrderTaxLine[]
  const lineTax = taxLines.reduce((sum, line) => sum + line.tax, 0)
  if (taxLines.length > 0 && lineTax !== tax) {
    errors.push({ message: 'The tax lines must add up to the tax', path: 'tax' })
  }
  if (taxLines.length === 0 && tax !== 0) {
    errors.push({ message: 'Tax needs at least one tax line', path: 'taxLines' })
  }

  const expected = subtotal - discount + (money.taxInclusive === true ? 0 : tax)
  if (discount <= subtotal && total !== expected) {
    errors.push({ message: `The total must be ${expected}: subtotal − discount${money.taxInclusive === true ? '' : ' + tax'}`, path: 'total' })
  }

  return errors
}

/** What an order takes from a quote snapshot (`snapshotQuote`). */
export type OrderFromQuote = OrderMoney & {
  addOns: OrderAddOnLine[]
  coupon: null | number | string
  couponCode: null | string
  plan: null | number | string
}

/**
 * Read the order fields out of a quote snapshot. Throws a message when the value is not a
 * snapshot this version can read; `orderMoneyProblems` then checks the numbers themselves.
 */
export const orderFieldsFromQuote = (quote: unknown): OrderFromQuote => {
  if (!isRecord(quote)) throw new Error('The quote must be a quote snapshot')
  if (quote.version !== QUOTE_SNAPSHOT_VERSION) {
    throw new Error(`The quote snapshot must be version ${QUOTE_SNAPSHOT_VERSION}`)
  }

  const tax = isRecord(quote.tax) ? quote.tax : null
  const plan = isRecord(quote.plan) ? quote.plan : null
  const coupon = isRecord(quote.coupon) ? quote.coupon : null
  const lines = Array.isArray(quote.lines) ? quote.lines.filter(isRecord) : null
  if (!tax || !plan || !lines || !Array.isArray(tax.breakdown)) {
    throw new Error('The quote snapshot is missing its plan, lines or tax')
  }

  const applied = coupon?.applied === true

  return {
    addOns: lines
      .filter((line) => line.kind === 'add-on')
      .map((line) => {
        const ref = isRecord(line.ref) ? line.ref : {}
        return {
          addOn: (ref.id as number | string | undefined) ?? null,
          amount: line.amount as number,
          durationDays: line.durationDays as number,
          included: line.included === true,
          key: (ref.key as null | string | undefined) ?? null,
          name: String(line.name ?? ''),
          placement: (line.placement as null | string | undefined) ?? null,
          unitPrice: line.unitPrice as number,
        }
      }),
    coupon: applied ? ((coupon.id as number | string | null | undefined) ?? null) : null,
    couponCode: applied ? ((coupon.code as null | string | undefined) ?? null) : null,
    currency: quote.currency as string,
    discount: quote.discount as number,
    plan: (plan.id as number | string | undefined) ?? null,
    subtotal: quote.subtotal as number,
    tax: tax.tax as number,
    taxInclusive: tax.pricesIncludeTax === true,
    taxLines: tax.breakdown.filter(isRecord).map((row) => ({
      gross: row.gross as number,
      key: String(row.key ?? ''),
      name: String(row.name ?? ''),
      net: row.net as number,
      rate: row.rate as number,
      tax: row.tax as number,
      xeroTaxType: (row.xeroTaxType as null | string | undefined) ?? null,
    })),
    total: quote.total as number,
  }
}

/**
 * A comparable form of a stored or submitted value: relationships as ids, array rows without
 * their row `id`, object keys sorted (Postgres `jsonb` does not keep key order), `undefined` and
 * `''` as `null`, and every scalar as text.
 */
export const canonicalOrderValue = (value: unknown): string => {
  const normalise = (input: unknown, inRow = false): unknown => {
    if (input === undefined || input === null || input === '') return null
    if (Array.isArray(input)) return input.map((entry) => normalise(entry, true))
    if (isRecord(input)) {
      // A populated relationship: compare by id.
      if (!inRow && 'id' in input && ('createdAt' in input || 'updatedAt' in input)) return String(input.id)
      const keys = Object.keys(input).filter((key) => !(inRow && key === 'id'))
      // Sorts the fresh array above; `toSorted` is ES2023, past this package's lib.
      // oxlint-disable-next-line unicorn/no-array-sort
      keys.sort()
      return Object.fromEntries(
        keys.map((key) => {
          const entry = input[key]
          // Relationships inside rows (e.g. `addOns.addOn`) can come back populated.
          if (isRecord(entry) && 'id' in entry && ('createdAt' in entry || 'updatedAt' in entry)) {
            return [key, String(entry.id)]
          }
          return [key, normalise(entry)]
        }),
      )
    }
    // Ids arrive as numbers or strings (`5` from the database, `"5"` from a form); compare text.
    return String(input)
  }

  return JSON.stringify(normalise(value))
}

/** A relationship value as a comparable id string, or null. */
const refKey = (value: unknown): null | string => {
  const id = tenantIDOf(value)
  return id === null ? null : String(id)
}

const externalRefKey = (ref: unknown): null | string => {
  if (!isRecord(ref)) return null
  const provider = typeof ref.provider === 'string' ? ref.provider.trim() : ''
  const id = typeof ref.id === 'string' ? ref.id.trim() : ''
  return provider && id ? `${provider}\u0000${id}` : null
}

const valueAfterSave = (
  data: Record<string, unknown> | undefined,
  originalDoc: Record<string, unknown> | undefined,
  path: string,
): unknown => (data && Object.prototype.hasOwnProperty.call(data, path) ? data[path] : originalDoc?.[path])

// ---------------------------------------------------------------------------------------------
// Hooks

export type OrderRulesOptions = {
  isOrganisationOwner?: OrganisationOwnerCheck
  paymentProviders?: readonly PaymentProviderDefinition[]
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
  usersSlug?: string
}

type LogEntry = {
  actor: OrderActor
  at: string
  by: null | number | string
  event: OrderLogEvent
  from?: null | string
  note?: null | string
  to?: null | string
}

/**
 * Every relation must point inside the order's tenant, and the jobs must be the organisation's.
 * The admin pickers are filtered by the multi-tenant plugin, but a REST or local API write could
 * still name another tenant's documents.
 */
export const orderRelationsInTenant =
  ({
    slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenantScoped = true,
  }: Pick<OrderRulesOptions, 'slugs' | 'tenantScoped'> = {}): CollectionBeforeChangeHook =>
  async ({ collection, data, operation, originalDoc, req }) => {
    const errors: { message: string; path: string }[] = []
    const tenantID = tenantScoped ? resultingTenantID(data, originalDoc) : null

    if (tenantScoped && tenantID === null) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'An order must belong to a tenant', path: 'tenant' }],
        req,
      })
    }

    // Checked first, so a move is reported as such rather than as relations in the wrong tenant.
    if (tenantScoped && operation === 'update' && refKey(tenantID) !== refKey(originalDoc?.tenant)) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'An order stays in its tenant', path: 'tenant' }],
        req,
      })
    }

    const organisationID = tenantIDOf(valueAfterSave(data, originalDoc, 'organisation'))
    if (organisationID === null) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: 'An order must belong to an organisation', path: 'organisation' }],
        req,
      })
    }

    const inTenant = (extra: Where[] = []): Where[] => [
      ...(tenantScoped ? [{ tenant: { equals: tenantID } }] : []),
      ...extra,
    ]

    const check = async (label: string, path: string, relationTo: string, ids: (number | string)[], extra: Where[] = []) => {
      if (ids.length === 0 || !hasCollection(req, relationTo)) return
      const unique = new Set(ids.map(String))
      const { totalDocs } = await req.payload.count({
        collection: relationTo as CollectionSlug,
        overrideAccess: true,
        req,
        where: { and: [{ id: { in: [...unique] } }, ...inTenant(extra)] },
      })
      if (totalDocs !== unique.size) errors.push({ message: label, path })
    }

    await check('Pick an organisation from this order’s tenant', 'organisation', slugs.organisations, [organisationID])
    await check(
      'Pick a plan from this order’s tenant',
      'plan',
      slugs.plans,
      idsOf([valueAfterSave(data, originalDoc, 'plan')]),
    )
    await check(
      'Pick a coupon from this order’s tenant',
      'coupon',
      slugs.coupons,
      idsOf([valueAfterSave(data, originalDoc, 'coupon')]),
    )
    const addOns = valueAfterSave(data, originalDoc, 'addOns')
    await check(
      'Pick add-ons from this order’s tenant',
      'addOns',
      slugs.addOns,
      idsOf((Array.isArray(addOns) ? addOns : []).map((row) => (isRecord(row) ? row.addOn : null))),
    )
    await check(
      'Pick jobs of this order’s organisation',
      'jobs',
      slugs.jobs,
      idsOf([valueAfterSave(data, originalDoc, 'jobs')].flat()),
      [{ organisation: { equals: organisationID } }],
    )

    if (errors.length > 0) throw new ValidationError({ collection: collection.slug, errors, req })
    return data
  }

/**
 * The order's money, payment and status rules, and its log.
 *
 * Create: a quote snapshot fills the money fields (submitted values must agree with it), the
 * money must add up, the payment method and provider must fit, and the log starts with `created`.
 *
 * Update: what was sold and its money never change; the tenant never changes; the organisation,
 * provider and legacy id change only by system code; existing external references stay; the
 * status moves only along `ORDER_TRANSITIONS` (narrower for an owner); `paidAt` is stamped on
 * payment; and each change is appended to the log, whatever the request sent for it.
 */
export const orderRules = ({
  isOrganisationOwner,
  paymentProviders = resolvePaymentProviders(),
  tenantScoped = true,
  usersSlug = 'users',
}: OrderRulesOptions = {}): CollectionBeforeChangeHook =>
  async ({ collection, data, operation, originalDoc, req }) => {
    const errors: { message: string; path: string }[] = []
    const fail = (): never => {
      throw new ValidationError({ collection: collection.slug, errors, req })
    }

    const next: Record<string, unknown> = { ...data }
    const organisationID = tenantIDOf(valueAfterSave(data, originalDoc, 'organisation'))
    const tenantID = tenantScoped ? resultingTenantID(data, originalDoc) : null
    const actor = await orderActorFor({
      isOrganisationOwner,
      organisationID: operation === 'update' ? tenantIDOf(originalDoc?.organisation) : organisationID,
      req,
      tenantID: operation === 'update' && tenantScoped ? tenantIDOf(originalDoc?.tenant) : tenantID,
      tenantScoped,
    })
    const user = userOf(req) as (MissionControlUser & { collection?: string }) | null
    const by = user && (user.collection === undefined || user.collection === usersSlug) ? (user.id ?? null) : null
    const now = new Date().toISOString()
    const entry = (fields: Omit<LogEntry, 'actor' | 'at' | 'by'>): LogEntry => ({ actor, at: now, by, ...fields })
    const statusNote = typeof data?.statusNote === 'string' && data.statusNote.trim() ? data.statusNote.trim() : null
    delete next.statusNote

    if (operation === 'create') {
      if (data?.quote !== undefined && data.quote !== null) {
        let fromQuote: OrderFromQuote | null = null
        try {
          fromQuote = orderFieldsFromQuote(data.quote)
        } catch (error) {
          errors.push({ message: (error as Error).message, path: 'quote' })
          fail()
        }

        for (const [key, value] of Object.entries(fromQuote as OrderFromQuote)) {
          const submitted = data[key]
          const empty =
            submitted === undefined ||
            submitted === null ||
            (Array.isArray(submitted) && submitted.length === 0) ||
            (key === 'taxInclusive' && submitted === false)
          if (empty) {
            next[key] = value
          } else if (canonicalOrderValue(submitted) !== canonicalOrderValue(value)) {
            errors.push({ message: 'Doesn’t match the quote', path: key })
          }
        }
        if (errors.length > 0) fail()
      }

      errors.push(...orderMoneyProblems(next as Partial<Record<keyof OrderMoney, unknown>>))
      if (errors.length > 0) fail()
    } else {
      for (const key of ORDER_IMMUTABLE_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(data ?? {}, key)) continue
        if (canonicalOrderValue(data?.[key]) !== canonicalOrderValue(originalDoc?.[key])) {
          errors.push({ message: 'Fixed once the order is created', path: key })
        }
      }

      if (tenantScoped && refKey(tenantID) !== refKey(originalDoc?.tenant)) {
        errors.push({ message: 'An order stays in its tenant', path: 'tenant' })
      }

      if (actor !== 'system') {
        for (const key of ORDER_SYSTEM_ONLY_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(data ?? {}, key)) continue
          if (canonicalOrderValue(data?.[key]) !== canonicalOrderValue(originalDoc?.[key])) {
            errors.push({ message: 'Only system code can change this once the order exists', path: key })
          }
        }
      }

      if (errors.length > 0) fail()
    }

    // Payment: the method fits the money, and an invoice names a registered provider.
    const method = valueAfterSave(next, originalDoc, 'paymentMethod') as OrderPaymentMethod | null | undefined
    const provider = valueAfterSave(next, originalDoc, 'paymentProvider')
    const total = valueAfterSave(next, originalDoc, 'total')

    if (method === 'invoice' && (provider === null || provider === undefined || provider === '')) {
      errors.push({ message: 'Pick the payment provider that invoices this order', path: 'paymentProvider' })
    }
    if (provider !== null && provider !== undefined && provider !== '' && !isRegisteredPaymentProvider(provider, paymentProviders)) {
      errors.push({
        message: `Use a registered payment provider: ${paymentProviders.map((p) => p.key).join(', ')}`,
        path: 'paymentProvider',
      })
    }
    if ((method === 'free' || method === 'credit') && total !== 0) {
      errors.push({ message: `A ${ORDER_PAYMENT_METHOD_LABELS[method].toLowerCase()} order must total 0`, path: 'paymentMethod' })
    }

    // External references: one per provider and id, and none removed once recorded.
    const refs = valueAfterSave(next, originalDoc, 'externalRefs')
    const refKeys = (Array.isArray(refs) ? refs : []).map(externalRefKey)
    if (refKeys.some((key) => key === null)) {
      errors.push({ message: 'Each external reference needs a provider and an id', path: 'externalRefs' })
    } else if (new Set(refKeys).size !== refKeys.length) {
      errors.push({ message: 'Each provider and id may appear only once', path: 'externalRefs' })
    }

    if (errors.length > 0) fail()

    const log: unknown[] =
      operation === 'create'
        ? actor === 'system' && Array.isArray(data?.log)
          ? [...data.log]
          : []
        : Array.isArray(originalDoc?.log)
          ? [...originalDoc.log]
          : []

    const to = (isOrderStatus(next.status) ? next.status : undefined) ?? (originalDoc?.status as OrderStatus | undefined) ?? 'pending'

    if (operation === 'create') {
      if (!isOrderStatus(to)) errors.push({ message: 'Pick a valid status', path: 'status' })
      log.push(entry({ event: 'created', note: statusNote, to }))
    } else {
      const from = isOrderStatus(originalDoc?.status) ? originalDoc.status : 'pending'
      const problem = orderTransitionProblem(from, to, actor)
      if (problem) errors.push({ message: problem, path: 'status' })
      else if (from !== to) log.push(entry({ event: 'status', from, note: statusNote, to }))

      const storedRefs: unknown[] = Array.isArray(originalDoc?.externalRefs) ? originalDoc.externalRefs : []
      const before = new Set<null | string>(storedRefs.map(externalRefKey))
      const after = new Set<null | string>(refKeys)
      for (const key of before) {
        if (key !== null && !after.has(key)) {
          errors.push({ message: 'External references are kept once recorded', path: 'externalRefs' })
          break
        }
      }
      for (const ref of Array.isArray(refs) ? refs : []) {
        const key = externalRefKey(ref)
        if (key !== null && !before.has(key) && isRecord(ref)) {
          log.push(entry({ event: 'external-ref', note: `${String(ref.provider)} ${String(ref.id)}` }))
        }
      }

      const jobsBefore = idsOf([originalDoc?.jobs].flat()).map(String)
      const jobsAfter = idsOf([valueAfterSave(next, originalDoc, 'jobs')].flat()).map(String)
      const sameJobs =
        new Set(jobsBefore).size === new Set(jobsAfter).size && jobsAfter.every((id) => jobsBefore.includes(id))
      if (!sameJobs) {
        log.push(entry({ event: 'jobs', from: jobsBefore.join(',') || null, to: jobsAfter.join(',') || null }))
      }

      const orgBefore = refKey(originalDoc?.organisation)
      const orgAfter = refKey(organisationID)
      if (orgBefore !== orgAfter) log.push(entry({ event: 'organisation', from: orgBefore, to: orgAfter }))
    }

    if (errors.length > 0) fail()

    // Paid orders carry the date they were paid: the submitted one (system code passes Xero's),
    // otherwise now.
    const paidNow = to === 'paid' && (operation === 'create' || originalDoc?.status !== 'paid')
    if (paidNow && !valueAfterSave(next, originalDoc, 'paidAt')) next.paidAt = now

    return { ...next, log, status: to }
  }

/**
 * Refuse to delete a document that orders point at (a tenant, an organisation or a job). Orders
 * are kept for accounting, and the relation would otherwise be nulled or dropped under them.
 */
export const refuseDeleteWhileOrdered =
  ({
    field,
    noun,
    ordersSlug = ORDERS_SLUG,
  }: {
    field: 'jobs' | 'organisation' | 'tenant'
    noun: string
    ordersSlug?: string
  }): CollectionBeforeDeleteHook =>
  async ({ collection, id, req }) => {
    if (!hasCollection(req, ordersSlug)) return

    const { totalDocs } = await req.payload.count({
      collection: ordersSlug as CollectionSlug,
      overrideAccess: true,
      req,
      where: field === 'jobs' ? { jobs: { in: [id] } } : { [field]: { equals: id } },
    })
    if (totalDocs === 0) return

    throw new ValidationError({
      collection: collection.slug,
      errors: [
        {
          message: `This ${noun} has ${totalDocs} order${totalDocs === 1 ? '' : 's'}, which are kept for accounting, so it can’t be deleted`,
          path: 'id',
        },
      ],
      req,
    })
  }

// ---------------------------------------------------------------------------------------------
// Collection

export type OrderCollectionOptions = {
  /** Overrides the collection's default access, operation by operation (PJ-80). */
  access?: CollectionAccess
  /** Who owns an organisation; without it only site managers and system code change orders. */
  isOrganisationOwner?: OrganisationOwnerCheck
  /** Registered providers (`resolvePaymentProviders`). Defaults to core's `invoice` only. */
  paymentProviders?: readonly PaymentProviderDefinition[]
  /** Resolved collection slugs, so relationships and queries never use a literal. */
  slugs?: PayloadJobsCollectionSlugs
  /** `false` in single-tenant mode, where there is no tenants collection. */
  tenantScoped?: boolean
  /** The auth collection whose users the log records. Defaults to `users`. */
  usersSlug?: string
}

const minorUnits = (name: string, description: string): Field => ({
  name,
  type: 'number',
  admin: { description, step: 1 },
  min: 0,
  required: true,
})

export const orderCollection = ({
  access,
  isOrganisationOwner,
  paymentProviders = resolvePaymentProviders(),
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
  usersSlug = 'users',
}: OrderCollectionOptions = {}): CollectionConfig => {
  const staffOnly = orderStaffFieldAccess(tenantScoped)
  const staffWrite = { create: staffOnly, update: staffOnly }
  const statusWrite = orderStatusFieldAccess(tenantScoped, isOrganisationOwner)
  const fixed = 'Fixed once the order is created.'

  const fields: Field[] = [
    {
      name: 'status',
      type: 'select',
      access: { create: staffOnly, update: statusWrite },
      defaultValue: 'pending',
      index: true,
      options: ORDER_STATUSES.map((value) => ({ label: ORDER_STATUS_LABELS[value], value })),
      required: true,
      admin: { position: 'sidebar' },
    },
    {
      name: 'statusNote',
      type: 'text',
      access: { create: staffOnly, update: statusWrite },
      virtual: true,
      admin: {
        description: 'Why the status changed. Saved in the history, not on the order.',
        position: 'sidebar',
      },
    },
    {
      name: 'organisation',
      type: 'relationship',
      access: staffWrite,
      index: true,
      relationTo: slugs.organisations as CollectionSlug,
      required: true,
      admin: { description: 'The organisation that owes and owns the order.' },
    },
    {
      name: 'plan',
      type: 'relationship',
      access: staffWrite,
      relationTo: slugs.plans as CollectionSlug,
      admin: { description: fixed },
    },
    {
      name: 'addOns',
      type: 'array',
      access: staffWrite,
      admin: { description: `What the add-ons were sold as. ${fixed}` },
      fields: [
        { name: 'addOn', type: 'relationship', relationTo: slugs.addOns as CollectionSlug },
        {
          type: 'row',
          fields: [
            { name: 'name', type: 'text', required: true },
            { name: 'key', type: 'text' },
            { name: 'placement', type: 'text' },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'durationDays', type: 'number', min: 0, required: true },
            { name: 'unitPrice', type: 'number', min: 0, required: true },
            { name: 'amount', type: 'number', min: 0, required: true },
            { name: 'included', type: 'checkbox', defaultValue: false },
          ],
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'coupon',
          type: 'relationship',
          access: staffWrite,
          relationTo: slugs.coupons as CollectionSlug,
        },
        {
          name: 'couponCode',
          type: 'text',
          access: staffWrite,
          admin: { description: 'The code as applied, kept if the coupon is later changed.' },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Money',
      admin: {
        description:
          'Whole minor units of the currency, so 500 is Vt 500 or $5.00. Fixed once the order is created.',
      },
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'currency',
              type: 'text',
              access: staffWrite,
              required: true,
              admin: { description: 'ISO 4217, e.g. VUV.' },
            },
            { ...minorUnits('subtotal', 'Before discounts.'), access: staffWrite } as Field,
            { ...minorUnits('discount', 'Credits and coupon.'), access: staffWrite } as Field,
          ],
        },
        {
          type: 'row',
          fields: [
            { ...minorUnits('tax', 'Sum of the tax lines.'), access: staffWrite } as Field,
            { ...minorUnits('total', 'What the organisation pays.'), access: staffWrite } as Field,
            {
              name: 'taxInclusive',
              type: 'checkbox',
              access: staffWrite,
              defaultValue: false,
              admin: { description: 'Prices included tax, so the total does not add it.' },
            },
          ],
        },
        {
          name: 'taxLines',
          type: 'array',
          access: staffWrite,
          fields: [
            {
              type: 'row',
              fields: [
                { name: 'key', type: 'text', required: true },
                { name: 'name', type: 'text', required: true },
                {
                  name: 'rate',
                  type: 'number',
                  min: 0,
                  required: true,
                  admin: { description: 'Basis points: 1500 is 15%.' },
                },
                { name: 'xeroTaxType', type: 'text' },
              ],
            },
            {
              type: 'row',
              fields: [
                { name: 'net', type: 'number', min: 0, required: true },
                { name: 'tax', type: 'number', min: 0, required: true },
                { name: 'gross', type: 'number', min: 0, required: true },
              ],
            },
          ],
        },
        {
          name: 'quote',
          type: 'json',
          access: staffWrite,
          admin: { description: 'The full quote the order was priced from (`snapshotQuote`).' },
        },
      ],
    },
    {
      type: 'collapsible',
      label: 'Payment',
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'paymentMethod',
              type: 'select',
              access: staffWrite,
              defaultValue: 'invoice',
              options: ORDER_PAYMENT_METHODS.map((value) => ({
                label: ORDER_PAYMENT_METHOD_LABELS[value],
                value,
              })),
              required: true,
            },
            {
              // Text, not a select: a new provider add-on must not need a schema migration.
              name: 'paymentProvider',
              type: 'text',
              access: staffWrite,
              index: true,
              validate: (value: null | string | undefined) =>
                value === null || value === undefined || value === '' || isRegisteredPaymentProvider(value, paymentProviders)
                  ? true
                  : `Use a registered payment provider: ${paymentProviders.map((provider) => provider.key).join(', ')}`,
              admin: {
                description: `The registered provider that collects the money: ${paymentProviders.map((provider) => provider.key).join(', ')}.`,
              },
            },
            {
              name: 'paidAt',
              type: 'date',
              access: staffWrite,
              index: true,
              admin: { description: 'Set when the order is paid.' },
            },
          ],
        },
        {
          name: 'externalRefs',
          type: 'array',
          access: staffWrite,
          admin: {
            description: 'Records in other systems, e.g. the Xero invoice. Kept once recorded.',
          },
          fields: [
            {
              type: 'row',
              fields: [
                { name: 'provider', type: 'text', required: true },
                { name: 'id', type: 'text', required: true },
                { name: 'url', type: 'text', validate: validateUrl },
              ],
            },
          ],
        },
      ],
    },
    {
      name: 'jobs',
      type: 'relationship',
      access: staffWrite,
      hasMany: true,
      relationTo: slugs.jobs as CollectionSlug,
      admin: { description: 'The jobs this order pays for. Must be the organisation’s.' },
    },
    {
      name: 'log',
      type: 'array',
      access: { create: noWrite, update: noWrite },
      admin: {
        description: 'Every change, oldest first. Nobody can edit it.',
        readOnly: true,
      },
      fields: [
        {
          type: 'row',
          fields: [
            { name: 'at', type: 'date', required: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
            {
              name: 'event',
              type: 'select',
              options: ORDER_LOG_EVENTS.map((value) => ({ label: value, value })),
              required: true,
            },
            {
              name: 'actor',
              type: 'select',
              options: ORDER_ACTORS.map((value) => ({ label: value, value })),
              required: true,
            },
            { name: 'by', type: 'relationship', relationTo: usersSlug as CollectionSlug },
          ],
        },
        {
          type: 'row',
          fields: [
            { name: 'from', type: 'text' },
            { name: 'to', type: 'text' },
            { name: 'note', type: 'text' },
          ],
        },
      ],
    },
    {
      name: 'legacyId',
      type: 'number',
      access: { ...staffWrite, read: staffOnly },
      index: true,
      admin: { description: 'WordPress transaction id, for the import.', position: 'sidebar' },
    },
  ]

  return {
    slug: slugs.orders,
    access: mergeCollectionAccess(
      {
        create: orderCreateAccess(tenantScoped),
        delete: orderDeleteAccess,
        read: orderReadAccess(tenantScoped),
        update: orderUpdateAccess(tenantScoped, isOrganisationOwner),
      },
      access,
    ),
    admin: {
      defaultColumns: ['id', 'organisation', 'status', 'total', 'currency', 'createdAt'],
      description: 'Orders belong to an organisation. Their money is fixed; the history is append-only.',
      group: 'Job board',
    },
    defaultSort: '-createdAt',
    fields,
    hooks: {
      beforeChange: [
        orderRelationsInTenant({ slugs, tenantScoped }),
        orderRules({ isOrganisationOwner, paymentProviders, tenantScoped, usersSlug }),
      ],
    },
    labels: { plural: 'Orders', singular: 'Order' },
    versions: false,
  }
}
