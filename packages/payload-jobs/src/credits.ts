import {
  APIError,
  commitTransaction,
  createPayloadRequest,
  initTransaction,
  killTransaction,
  ValidationError,
  type Access,
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type CollectionSlug,
  type Endpoint,
  type FieldAccess,
  type Payload,
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
import {
  packCreditGrantProblem,
  packCreditModeForOrder,
  type PackCreditMode,
} from './credit-settings'
import {
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  mergeCollectionAccess,
  type CollectionAccess,
  type PayloadJobsCollectionSlugs,
} from './slugs'

/**
 * Organisation job credits (PJ-24): an append-only ledger.
 *
 * Every credit movement is one row that never changes: bought +N (a pack order), used −1 (a job
 * paid with a credit), refunded +1 (that job cancelled before it was ever published), an admin
 * adjustment ±N with a required note, or an opening balance carried over from WordPress (PJ-65).
 * Who made it (`createdBy`, stamped by Payload) and when (`createdAt`) are kept with it. The
 * balance is the sum of an organisation's rows: it is never stored, so it can't be edited.
 *
 * Race safety. Every write takes a Postgres transaction-scoped advisory lock on the organisation
 * before it reads the balance, so two writes for one organisation run one after the other and the
 * balance can't go below zero. Each kind of row that must happen once (a pack order's grant, a
 * job's use for one order, a job's refund, a legacy opening row) carries an idempotency key that
 * the collection fills in itself and the database keeps unique.
 *
 * Credits never expire in the MVP (decision 19 Nov); expiry would be a per-tenant option, off.
 *
 * Out of scope: checkout (PJ-31) decides when to grant and consume, the employer History page
 * (PJ-82) renders `organisationHistory`, and the legacy import (PJ-65) writes opening rows.
 */

export const CREDIT_LEDGER_SLUG = 'credit-ledger'

export const CREDIT_REASONS = ['bought', 'used', 'refunded', 'adjustment', 'opening'] as const
export type CreditReason = (typeof CREDIT_REASONS)[number]

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  adjustment: 'Adjustment',
  bought: 'Bought',
  opening: 'Opening balance',
  refunded: 'Refunded',
  used: 'Used',
}

export const isCreditReason = (value: unknown): value is CreditReason =>
  typeof value === 'string' && (CREDIT_REASONS as readonly string[]).includes(value)

/** Who wrote a row: system code (checkout, import, hooks) or a site manager (an adjustment). */
export const CREDIT_ACTORS = ['system', 'staff'] as const
export type CreditActor = (typeof CREDIT_ACTORS)[number]

/** Site managers: credits are money, so tenant admins only (as for orders). */
export const CREDIT_STAFF_ROLES = ['tenant-admin'] as const satisfies readonly TenantRole[]

/** Members of an organisation, who read its credit history. */
export const CREDIT_MEMBER_ROLES = ['employer'] as const satisfies readonly TenantRole[]

/**
 * Set on `req.context` by the helpers below: the write is system code's, even when the request
 * carries a signed-in user (who is still stamped as `createdBy`). A request without a user is
 * already system code.
 */
export const CREDIT_SYSTEM_CONTEXT = 'creditLedgerSystem'

/**
 * Set on `req.context` only by code that removes a whole tenant's data on purpose (test teardown,
 * a future offboarding task, PJ-93). Without it nobody, not even system code, deletes a row.
 */
export const CREDIT_LEDGER_PURGE_CONTEXT = 'payloadJobsPurge'

/** First key of the advisory lock: "PJ24" as a 32-bit integer, so it can't clash with others'. */
export const CREDIT_LOCK_NAMESPACE = 0x504a3234

/** The reasons only system code writes. Site managers make adjustments only. */
const SYSTEM_ONLY_REASONS: readonly CreditReason[] = ['bought', 'used', 'refunded', 'opening']

export type CreditLedgerErrorCode =
  | 'already-recorded'
  | 'insufficient-credits'
  | 'invalid'
  | 'needs-transaction'
  | 'not-refundable'

/**
 * A refused credit movement, with a code callers can branch on. An API error, so a site manager
 * in the admin sees the reason (400, or 409 for a repeat) instead of a generic server error; a
 * missing transaction is the server's fault and stays private (500).
 */
export class CreditLedgerError extends APIError<{ code: CreditLedgerErrorCode }> {
  readonly code: CreditLedgerErrorCode

  constructor(code: CreditLedgerErrorCode, message: string) {
    const status = code === 'needs-transaction' ? 500 : code === 'already-recorded' ? 409 : 400
    super(message, status, { code }, code !== 'needs-transaction')
    this.code = code
    this.name = 'CreditLedgerError'
  }
}

type ID = number | string

type LedgerRow = {
  createdAt?: string
  createdBy?: unknown
  delta: number
  id: ID
  idempotencyKey?: null | string
  job?: unknown
  legacyRef?: null | string
  note?: null | string
  order?: unknown
  organisation: unknown
  reason: CreditReason
  tenant?: unknown
}

const userOf = (req: PayloadRequest): MissionControlUser | null =>
  (req.user as MissionControlUser | null | undefined) ?? null

const refKey = (value: unknown): null | string => {
  const id = tenantIDOf(value)
  return id === null ? null : String(id)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasCollection = (req: PayloadRequest, slug: string): boolean =>
  Boolean((req.payload?.collections as Record<string, unknown> | undefined)?.[slug])

const textOf = (value: unknown): null | string =>
  typeof value === 'string' && value.trim() ? value.trim() : null

// ---------------------------------------------------------------------------------------------
// Pure rules

/** True for a whole, non-zero number of credits that is exact in a JS number. */
export const isCreditDelta = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value !== 0

/** Sum credit deltas, throwing instead of losing precision. */
export const sumCreditDeltas = (deltas: readonly number[]): number => {
  let total = 0
  for (const delta of deltas) {
    if (!Number.isSafeInteger(delta)) throw new CreditLedgerError('invalid', 'A credit delta must be a whole number')
    total += delta
    if (!Number.isSafeInteger(total)) throw new CreditLedgerError('invalid', 'The credit balance is too large')
  }
  return total
}

export type CreditMovement = {
  delta: unknown
  job?: unknown
  legacyRef?: unknown
  note?: unknown
  order?: unknown
  reason: unknown
}

/** Everything wrong with a movement on its own (no database), as field errors. */
export const creditMovementProblems = (movement: CreditMovement): { message: string; path: string }[] => {
  const errors: { message: string; path: string }[] = []
  const { delta, reason } = movement

  if (!isCreditReason(reason)) {
    errors.push({ message: `Pick a reason: ${CREDIT_REASONS.join(', ')}`, path: 'reason' })
    return errors
  }
  if (!isCreditDelta(delta)) {
    errors.push({ message: 'Use a whole number of credits other than 0', path: 'delta' })
    return errors
  }

  const order = refKey(movement.order)
  const job = refKey(movement.job)

  switch (reason) {
    case 'bought':
      if (delta < 1) errors.push({ message: 'Bought credits are added, so the change must be 1 or more', path: 'delta' })
      if (order === null) errors.push({ message: 'Bought credits come from an order', path: 'order' })
      if (job !== null) errors.push({ message: 'Bought credits are not for one job', path: 'job' })
      break
    case 'used':
      if (delta !== -1) errors.push({ message: 'A job uses exactly one credit (−1)', path: 'delta' })
      if (job === null) errors.push({ message: 'A used credit names the job it paid for', path: 'job' })
      break
    case 'refunded':
      if (delta !== 1) errors.push({ message: 'A refund gives back exactly one credit (+1)', path: 'delta' })
      if (job === null) errors.push({ message: 'A refund names the cancelled job', path: 'job' })
      break
    case 'adjustment':
      if (textOf(movement.note) === null) {
        errors.push({ message: 'Say why the credits are adjusted', path: 'note' })
      }
      break
    case 'opening':
      if (delta < 1) errors.push({ message: 'An opening balance must be 1 or more', path: 'delta' })
      if (textOf(movement.legacyRef) === null) {
        errors.push({ message: 'An opening balance names its legacy record', path: 'legacyRef' })
      }
      if (order !== null || job !== null) {
        errors.push({ message: 'An opening balance is not for an order or a job', path: order !== null ? 'order' : 'job' })
      }
      break
  }

  return errors
}

/**
 * The key that makes a movement happen once, or `null` when it may repeat (an adjustment with no
 * key of its own). Order and job ids are unique across tenants; a legacy ref is not, so it is
 * prefixed with the tenant.
 */
export const creditIdempotencyKey = (
  movement: CreditMovement & { idempotencyKey?: unknown; tenant?: unknown },
): null | string => {
  const order = refKey(movement.order)
  const job = refKey(movement.job)
  switch (movement.reason) {
    case 'bought':
      return order === null ? null : `bought:order:${order}`
    case 'used':
      return job === null ? null : order === null ? `used:job:${job}` : `used:job:${job}:order:${order}`
    case 'refunded':
      return job === null ? null : `refunded:job:${job}`
    case 'opening': {
      const ref = textOf(movement.legacyRef)
      return ref === null ? null : `opening:${refKey(movement.tenant) ?? '-'}:${ref}`
    }
    case 'adjustment': {
      const key = textOf(movement.idempotencyKey)
      return key === null ? null : `adjustment:${key}`
    }
    default:
      return null
  }
}

/** The 32-bit FNV-1a hash of `text`, as a signed integer (the type `pg_advisory_xact_lock` takes). */
export const creditLockKey = (text: string): number => {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash | 0
}

// ---------------------------------------------------------------------------------------------
// Database: lock, balance, rows

/**
 * Take the organisation's credit lock for the rest of `req`'s transaction. Advisory locks are
 * re-entrant within one transaction, so the helper and the collection hook may both take it.
 *
 * Throws unless the request is inside a Postgres transaction at READ COMMITTED: there, each
 * statement after the lock sees every row committed by the transaction that held it before. A
 * stricter level would read a snapshot from before the wait, and an adapter without transactions
 * can't hold a lock at all, so both are refused rather than risking a negative balance.
 */
export const lockOrganisationCredits = async (req: PayloadRequest, organisationID: ID): Promise<void> => {
  const db = req.payload.db as unknown as {
    execute?: (args: { db: unknown; raw: string }) => Promise<unknown>
    sessions?: Record<string, { db?: unknown } | undefined>
  }
  const transactionID = await req.transactionID
  const session = transactionID === undefined || transactionID === null ? undefined : db.sessions?.[String(transactionID)]?.db

  if (!session || typeof db.execute !== 'function') {
    throw new CreditLedgerError('needs-transaction', 'Credit movements need a Postgres database transaction')
  }

  // Both keys are integers computed here, so the statement carries no outside text.
  const key = creditLockKey(String(organisationID))
  const result = (await db.execute({
    db: session,
    raw: `SELECT pg_advisory_xact_lock(${CREDIT_LOCK_NAMESPACE}, ${key}), current_setting('transaction_isolation') AS isolation`,
  })) as { rows?: { isolation?: unknown }[] }

  const isolation = result?.rows?.[0]?.isolation
  if (isolation !== 'read committed') {
    throw new CreditLedgerError(
      'needs-transaction',
      `Credit movements need READ COMMITTED transactions, not ${String(isolation)}`,
    )
  }
}

/** The collection slug the plugin registered for the ledger, or the default. */
export const creditLedgerSlugFor = (payload: Payload): string => slugsFor(payload).creditLedger

/** The slugs the plugin resolved (kept on its plug-point registry), or the defaults. */
const slugsFor = (payload: Payload): PayloadJobsCollectionSlugs => {
  const custom = payload.config?.custom as
    | { payloadJobs?: { registry?: { context?: { slugs?: PayloadJobsCollectionSlugs } } } }
    | undefined
  return custom?.payloadJobs?.registry?.context?.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
}

const ledgerRows = async (
  req: PayloadRequest,
  slug: string,
  where: Where,
): Promise<LedgerRow[]> => {
  const { docs } = await req.payload.find({
    collection: slug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'createdAt',
    where,
  })
  return docs as unknown as LedgerRow[]
}

/** The balance from the rows `req` can see: inside a locked transaction, the current one. */
const balanceInside = async (req: PayloadRequest, slug: string, organisationID: ID): Promise<number> => {
  const { docs } = await req.payload.find({
    collection: slug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    select: { delta: true } as never,
    where: { organisation: { equals: organisationID } },
  })
  return sumCreditDeltas(docs.map((doc) => (doc as unknown as { delta: number }).delta))
}

/** A job's credit rows: how many it used and whether it was refunded. */
const jobCreditState = async (req: PayloadRequest, slug: string, jobID: ID) => {
  const rows = await ledgerRows(req, slug, {
    and: [{ job: { equals: jobID } }, { reason: { in: ['used', 'refunded'] } }],
  })
  const used = rows.filter((row) => row.reason === 'used').length
  const refunded = rows.filter((row) => row.reason === 'refunded').length
  return { refunded, used }
}

// ---------------------------------------------------------------------------------------------
// Access

const memberScope = (user: MissionControlUser, tenantScoped: boolean): null | Where => {
  const organisation = getUserOrganisationID(user)
  if (organisation === null) return null
  if (!tenantScoped) {
    return hasAnyTenantRole(user, CREDIT_MEMBER_ROLES) ? { organisation: { equals: organisation } } : null
  }
  const tenants = getUserTenantIDsByRole(user, CREDIT_MEMBER_ROLES)
  if (tenants.length === 0) return null
  return { and: [{ organisation: { equals: organisation } }, { tenant: { in: tenants } }] }
}

const staffScope = (user: MissionControlUser, tenantScoped: boolean): null | true | Where => {
  if (!tenantScoped) return hasAnyTenantRole(user, CREDIT_STAFF_ROLES) ? true : null
  const tenants = getUserTenantIDsByRole(user, CREDIT_STAFF_ROLES)
  return tenants.length > 0 ? { tenant: { in: tenants } } : null
}

const isStaffFor = (user: MissionControlUser, tenantID: null | ID, tenantScoped: boolean): boolean => {
  if (isSuperAdmin(user)) return true
  if (!tenantScoped) return hasAnyTenantRole(user, CREDIT_STAFF_ROLES)
  return tenantID !== null && hasTenantRole(user, tenantID, CREDIT_STAFF_ROLES)
}

/**
 * Read: super admins everything; site managers their tenants; employers their own organisation's
 * rows in the tenants where they are employers. Editors, seekers, site keys and anonymous callers
 * see nothing.
 */
export const creditLedgerReadAccess =
  (tenantScoped: boolean): Access =>
  ({ req }) => {
    const user = userOf(req)
    if (!user) return false
    if (isSuperAdmin(user)) return true
    if (isSeekerOnly(user)) return false

    const staff = staffScope(user, tenantScoped)
    if (staff === true) return true
    const scopes = [staff, memberScope(user, tenantScoped)].filter((scope): scope is Where => scope !== null)
    if (scopes.length === 0) return false
    return scopes.length === 1 ? scopes[0] : { or: scopes }
  }

/**
 * Create: site managers, in the submitted tenant, and only adjustments (the hook refuses every
 * other reason from a user). Everything else is written by the helpers as system code.
 */
export const creditLedgerCreateAccess =
  (tenantScoped: boolean): Access =>
  ({ data, req }) => {
    const user = userOf(req)
    if (!user) return false
    if (!tenantScoped) return isSuperAdmin(user) || hasAnyTenantRole(user, CREDIT_STAFF_ROLES)
    const submitted = tenantIDOf((data as { tenant?: unknown } | undefined)?.tenant)
    if (submitted === null) return false
    return isStaffFor(user, submitted, tenantScoped)
  }

/** Rows never change and are never removed. The hooks enforce this even past access. */
export const creditLedgerNoAccess: Access = () => false

/** Fields members don't read: the import's reference and the idempotency key. */
const staffReadField =
  (tenantScoped: boolean): FieldAccess =>
  ({ doc, req }) => {
    if (req.context?.[CREDIT_SYSTEM_CONTEXT] === true) return true
    const user = userOf(req)
    if (!user) return true
    return isStaffFor(user, tenantIDOf(doc?.tenant), tenantScoped)
  }

/** Fields the collection fills in itself. */
const systemOnlyField: FieldAccess = ({ req }) => req.context?.[CREDIT_SYSTEM_CONTEXT] === true || !userOf(req)

// ---------------------------------------------------------------------------------------------
// Hooks

export type CreditLedgerRulesOptions = {
  slug?: string
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
}

/**
 * The ledger's rules, on every create, whoever writes:
 * - an update is refused, even with `overrideAccess`: rows are immutable;
 * - the reason, change, order, job and note must fit (`creditMovementProblems`);
 * - only system code writes anything but an adjustment;
 * - the organisation, order and job must be in the row's tenant, and the order and job the
 *   organisation's;
 * - a refund is for a job that used a credit, was never published and is now cancelled;
 * - under the organisation's lock: the idempotency key is new and the balance stays 0 or more.
 */
export const creditLedgerRules =
  ({
    slug = CREDIT_LEDGER_SLUG,
    slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenantScoped = true,
  }: CreditLedgerRulesOptions = {}): CollectionBeforeChangeHook =>
  async ({ collection, data, operation, originalDoc, req }) => {
    const fail = (errors: { message: string; path: string }[]): never => {
      throw new ValidationError({ collection: collection.slug, errors, req })
    }

    if (operation !== 'create') {
      fail([{ message: 'Credit history can’t be changed. Record an adjustment instead.', path: 'id' }])
    }

    const actor: CreditActor = req.context?.[CREDIT_SYSTEM_CONTEXT] === true || !userOf(req) ? 'system' : 'staff'
    const tenantID = tenantScoped ? resultingTenantID(data, originalDoc) : null
    const organisationID = tenantIDOf(data?.organisation)
    const movement = {
      delta: data?.delta,
      job: data?.job ?? null,
      legacyRef: data?.legacyRef ?? null,
      note: data?.note ?? null,
      order: data?.order ?? null,
      reason: data?.reason,
    }

    const errors = creditMovementProblems(movement)
    if (tenantScoped && tenantID === null) errors.push({ message: 'A credit row must belong to a tenant', path: 'tenant' })
    if (organisationID === null) errors.push({ message: 'A credit row must belong to an organisation', path: 'organisation' })
    if (actor !== 'system' && SYSTEM_ONLY_REASONS.includes(movement.reason as CreditReason)) {
      errors.push({ message: 'Site managers record adjustments only; the rest comes from orders and jobs', path: 'reason' })
    }
    if (errors.length > 0) fail(errors)

    const reason = movement.reason as CreditReason
    const delta = movement.delta as number
    const orgID = organisationID as ID
    const inTenant: Where[] = tenantScoped ? [{ tenant: { equals: tenantID } }] : []
    const exists = async (relationTo: string, id: ID, extra: Where[] = []): Promise<boolean> => {
      if (!hasCollection(req, relationTo)) return false
      const { totalDocs } = await req.payload.count({
        collection: relationTo as CollectionSlug,
        overrideAccess: true,
        req,
        where: { and: [{ id: { equals: id } }, ...inTenant, ...extra] },
      })
      return totalDocs === 1
    }

    if (!(await exists(slugs.organisations, orgID))) {
      errors.push({ message: 'Pick an organisation from this row’s tenant', path: 'organisation' })
    }
    const orderID = tenantIDOf(movement.order)
    if (orderID !== null && !(await exists(slugs.orders, orderID, [{ organisation: { equals: orgID } }]))) {
      errors.push({ message: 'Pick an order of this organisation', path: 'order' })
    }
    const jobID = tenantIDOf(movement.job)
    if (jobID !== null && !(await exists(slugs.jobs, jobID, [{ organisation: { equals: orgID } }]))) {
      errors.push({ message: 'Pick a job of this organisation', path: 'job' })
    }
    if (errors.length > 0) fail(errors)

    // From here on, one writer per organisation at a time.
    await lockOrganisationCredits(req, orgID)

    const idempotencyKey = creditIdempotencyKey({ ...movement, idempotencyKey: data?.idempotencyKey, tenant: tenantID })
    if (idempotencyKey !== null) {
      const { totalDocs } = await req.payload.count({
        collection: slug as CollectionSlug,
        overrideAccess: true,
        req,
        where: { idempotencyKey: { equals: idempotencyKey } },
      })
      if (totalDocs > 0) {
        throw new CreditLedgerError('already-recorded', `This credit movement is already recorded (${idempotencyKey})`)
      }
    }

    if (reason === 'refunded') {
      const job = (await req.payload.findByID({
        collection: slugs.jobs as CollectionSlug,
        depth: 0,
        id: jobID as ID,
        overrideAccess: true,
        req,
        select: { publishedAt: true, status: true } as never,
      })) as { publishedAt?: null | string; status?: string }
      const state = await jobCreditState(req, slug, jobID as ID)
      if (job.status !== 'cancelled' || job.publishedAt) {
        throw new CreditLedgerError('not-refundable', 'Only a job cancelled before it was published gets its credit back')
      }
      if (state.used === 0 || state.refunded >= state.used) {
        throw new CreditLedgerError('not-refundable', 'This job has no unrefunded credit to give back')
      }
    }

    const balance = await balanceInside(req, slug, orgID)
    if (balance + delta < 0) {
      throw new CreditLedgerError(
        'insufficient-credits',
        `Not enough credits: the balance is ${balance} and this needs ${-delta}`,
      )
    }

    return {
      ...data,
      actor,
      delta,
      idempotencyKey,
      job: jobID,
      legacyRef: textOf(movement.legacyRef),
      note: textOf(movement.note),
      order: orderID,
      organisation: orgID,
      reason,
    }
  }

/** Nobody deletes a credit row, not even system code, unless a whole tenant is purged on purpose. */
export const refuseCreditLedgerDelete: CollectionBeforeDeleteHook = ({ collection, req }) => {
  if (req.context?.[CREDIT_LEDGER_PURGE_CONTEXT] === true) return
  throw new ValidationError({
    collection: collection.slug,
    errors: [{ message: 'Credit history is kept for good. Record an adjustment instead.', path: 'id' }],
    req,
  })
}

/**
 * Refuse to delete a tenant, organisation, order or job that credit rows point at: the relation
 * would be nulled under them and the history would lose its meaning.
 */
export const refuseDeleteWhileInCreditLedger =
  ({
    field,
    ledgerSlug = CREDIT_LEDGER_SLUG,
    noun,
  }: {
    field: 'job' | 'order' | 'organisation' | 'tenant'
    ledgerSlug?: string
    noun: string
  }): CollectionBeforeDeleteHook =>
  async ({ collection, id, req }) => {
    if (req.context?.[CREDIT_LEDGER_PURGE_CONTEXT] === true) return
    if (!hasCollection(req, ledgerSlug)) return
    const { totalDocs } = await req.payload.count({
      collection: ledgerSlug as CollectionSlug,
      overrideAccess: true,
      req,
      where: { [field]: { equals: id } },
    })
    if (totalDocs === 0) return
    throw new ValidationError({
      collection: collection.slug,
      errors: [
        {
          message: `This ${noun} has ${totalDocs} credit movement${totalDocs === 1 ? '' : 's'}, which are kept, so it can’t be deleted`,
          path: 'id',
        },
      ],
      req,
    })
  }

// ---------------------------------------------------------------------------------------------
// Helpers (system code)

export type CreditHelperArgs = {
  payload: Payload
  /**
   * The request to run in. Pass the caller's to share its transaction (a hook, an endpoint); its
   * user, if any, is stamped as `createdBy`. Without one, a fresh system request is used.
   */
  req?: PayloadRequest
  /** The ledger's collection slug. Defaults to the one the plugin registered. */
  slug?: string
}

export type CreditWriteResult = {
  /** The organisation's balance after this call. */
  balance: number
  /** False when the same movement was already recorded (an idempotent retry). */
  created: boolean
  entry: LedgerRow
}

const requestFor = async ({ payload, req }: CreditHelperArgs): Promise<PayloadRequest> =>
  req ?? createPayloadRequest({ payload })

/**
 * Run `fn` inside a transaction holding the organisation's credit lock. Joins the request's
 * transaction when it has one (the caller commits), otherwise opens and commits its own.
 */
export const withOrganisationCreditLock = async <T>(
  req: PayloadRequest,
  organisationID: ID,
  fn: () => Promise<T>,
): Promise<T> => {
  const owns = await initTransaction(req)
  try {
    await lockOrganisationCredits(req, organisationID)
    const result = await fn()
    if (owns) await commitTransaction(req)
    return result
  } catch (error) {
    if (owns) await killTransaction(req)
    throw error
  }
}

const recordMovement = async (
  args: CreditHelperArgs,
  movement: {
    delta: number
    idempotencyKey?: null | string
    job?: ID | null
    legacyRef?: null | string
    note?: null | string
    order?: ID | null
    organisation: ID
    reason: CreditReason
    tenant: ID | null
  },
): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slug = args.slug ?? creditLedgerSlugFor(args.payload)

  return withOrganisationCreditLock(req, movement.organisation, async () => {
    const key = creditIdempotencyKey(movement)
    if (key !== null) {
      const [existing] = await ledgerRows(req, slug, { idempotencyKey: { equals: key } })
      if (existing) {
        if (refKey(existing.organisation) !== String(movement.organisation)) {
          throw new CreditLedgerError('already-recorded', 'This movement is recorded for another organisation')
        }
        return { balance: await balanceInside(req, slug, movement.organisation), created: false, entry: existing }
      }
    }

    const hadFlag = Object.prototype.hasOwnProperty.call(req.context ?? {}, CREDIT_SYSTEM_CONTEXT)
    const previous = req.context?.[CREDIT_SYSTEM_CONTEXT]
    req.context = { ...req.context, [CREDIT_SYSTEM_CONTEXT]: true }
    try {
      const entry = (await req.payload.create({
        collection: slug as CollectionSlug,
        data: {
          delta: movement.delta,
          idempotencyKey: movement.idempotencyKey ?? null,
          job: movement.job ?? null,
          legacyRef: movement.legacyRef ?? null,
          note: movement.note ?? null,
          order: movement.order ?? null,
          organisation: movement.organisation,
          reason: movement.reason,
          ...(movement.tenant === null ? {} : { tenant: movement.tenant }),
        } as never,
        depth: 0,
        overrideAccess: true,
        req,
      })) as unknown as LedgerRow
      return { balance: await balanceInside(req, slug, movement.organisation), created: true, entry }
    } finally {
      if (hadFlag) req.context[CREDIT_SYSTEM_CONTEXT] = previous
      else delete req.context[CREDIT_SYSTEM_CONTEXT]
    }
  })
}

type Loaded = Record<string, unknown> & { id: ID }

const load = async (req: PayloadRequest, collection: string, id: ID): Promise<Loaded> => {
  try {
    return (await req.payload.findByID({
      collection: collection as CollectionSlug,
      depth: 0,
      id,
      overrideAccess: true,
      req,
    })) as unknown as Loaded
  } catch {
    throw new CreditLedgerError('invalid', `No ${collection} with id ${String(id)}`)
  }
}

/**
 * Every order status that may grant a pack's credits, whatever the tenant's
 * `packCreditsUsableAt` says: invoiced or paid. Which of the two applies is the tenant's choice
 * (`packCreditGrantProblem`).
 */
export const CREDIT_GRANTING_ORDER_STATUSES = ['invoiced', 'paid'] as const

/** The credits an order's quote snapshot grants (`entitlements.jobCreditsGranted`), or `null`. */
export const creditsGrantedByQuote = (quote: unknown): null | number => {
  if (!isRecord(quote) || !isRecord(quote.entitlements)) return null
  const granted = quote.entitlements.jobCreditsGranted
  return typeof granted === 'number' && Number.isSafeInteger(granted) ? granted : null
}

/**
 * The credits an order buys as a *pack*, or 0. A plan that includes more than the one listing it
 * sells is a pack (the same `jobCredits > 1` rule checkout uses); a single listing grants nothing
 * extra, whatever its quote says.
 */
export const packCreditsGrantedByQuote = (quote: unknown): number => {
  if (!isRecord(quote) || !isRecord(quote.plan)) return 0
  const planCredits = quote.plan.jobCredits
  if (typeof planCredits !== 'number' || planCredits <= 1) return 0
  const granted = creditsGrantedByQuote(quote) ?? 0
  return granted > 0 ? granted : 0
}

/**
 * Add an order's credits to its organisation (reason `bought`). The number comes from the order's
 * quote (`entitlements.jobCreditsGranted`); `credits` is only for an order without one and must
 * agree with it otherwise. An order grants once: calling again returns the first row.
 *
 * The order must be in a status the tenant's `packCreditsUsableAt` accepts: paid, or invoiced or
 * paid when the site grants on invoice (PJ-120). Checkout (PJ-31), the payment sync and the
 * order's own paid hook decide when that is.
 */
export const grantCredits = async (
  args: CreditHelperArgs & { credits?: number; order: ID; packCreditMode?: PackCreditMode },
): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slugs = slugsFor(args.payload)
  const order = await load(req, slugs.orders, args.order)
  const fromQuote = creditsGrantedByQuote(order.quote)

  if (fromQuote !== null && args.credits !== undefined && args.credits !== fromQuote) {
    throw new CreditLedgerError('invalid', `This order grants ${fromQuote} credits, not ${args.credits}`)
  }
  const credits = fromQuote ?? args.credits
  if (credits === undefined || !Number.isSafeInteger(credits) || credits < 1) {
    throw new CreditLedgerError('invalid', 'This order grants no job credits')
  }
  const mode = args.packCreditMode ?? (await packCreditModeForOrder({ order, payload: args.payload, req }))
  const problem = packCreditGrantProblem({ mode, status: order.status })
  if (problem !== null) throw new CreditLedgerError('invalid', problem)

  return recordMovement(
    { ...args, req },
    {
      delta: credits,
      order: order.id,
      organisation: tenantIDOf(order.organisation) as ID,
      reason: 'bought',
      tenant: tenantIDOf(order.tenant),
    },
  )
}

/**
 * Orders hook: when an order becomes paid, grant the pack's credits and use one for the job it
 * paid for (PJ-120). A site that grants on invoice already did both at checkout; a site that
 * grants on payment waited for this, whether the order was marked paid by staff, by the Xero
 * payment sync (PJ-118) or by a payment provider. Paid is the one status both modes accept, so
 * the mode needs no check here, and the ledger's idempotency keys make a second run a no-op.
 *
 * Only a transition into `paid` is handled, so an order cancelled or failed before payment
 * grants nothing. A job cancelled before the order was paid keeps every credit: it can't use one.
 */
export const grantPackCreditsOnPaid =
  ({ slug, tenantScoped = true }: { slug?: string; tenantScoped?: boolean } = {}): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    if (doc?.status !== 'paid' || (operation === 'update' && previousDoc?.status === 'paid')) return doc

    const ledger = slug ?? creditLedgerSlugFor(req.payload)
    if (!hasCollection(req, ledger)) return doc
    if (packCreditsGrantedByQuote(doc.quote) < 1) return doc
    if (tenantScoped && tenantIDOf(doc.tenant) === null) return doc

    await grantCredits({ order: doc.id, payload: req.payload, req, slug: ledger })

    // The credit that pays for the job the pack was bought with, exactly as checkout would have
    // used it. Only when this order still pays for that job: a relisted job has its own order.
    const jobsSlug = slugsFor(req.payload).jobs
    const jobID = idsOf([doc.jobs].flat())[0] ?? null
    if (jobID === null || !hasCollection(req, jobsSlug)) return doc
    const job = (await req.payload.findByID({
      collection: jobsSlug as CollectionSlug,
      depth: 0,
      disableErrors: true,
      id: jobID,
      overrideAccess: true,
      req,
      select: { order: true, status: true } as never,
    })) as null | { order?: unknown; status?: unknown }
    if (!job || job.status === 'cancelled' || refKey(job.order) !== refKey(doc.id)) return doc

    await consumeCredit({ job: jobID, order: doc.id, payload: req.payload, req, slug: ledger })
    return doc
  }

/**
 * Take one credit from the job's organisation for the job (reason `used`), optionally for the
 * order that paid with it. Throws `insufficient-credits` when the balance is 0. One use per job
 * and order: calling again returns the first row.
 */
export const consumeCredit = async (
  args: CreditHelperArgs & { job: ID; order?: ID | null },
): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slugs = slugsFor(args.payload)
  const job = await load(req, slugs.jobs, args.job)
  if (job.status === 'cancelled') throw new CreditLedgerError('invalid', 'A cancelled job can’t use a credit')

  return recordMovement(
    { ...args, req },
    {
      delta: -1,
      job: job.id,
      order: args.order ?? null,
      organisation: tenantIDOf(job.organisation) as ID,
      reason: 'used',
      tenant: tenantIDOf(job.tenant),
    },
  )
}

/**
 * Give a job's credit back (reason `refunded`): only for a job that used one, was never published
 * and is now cancelled, and only once. Calling again returns the first refund.
 */
export const refundCredit = async (args: CreditHelperArgs & { job: ID }): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slugs = slugsFor(args.payload)
  const job = await load(req, slugs.jobs, args.job)

  return recordMovement(
    { ...args, req },
    {
      delta: 1,
      job: job.id,
      organisation: tenantIDOf(job.organisation) as ID,
      reason: 'refunded',
      tenant: tenantIDOf(job.tenant),
    },
  )
}

/**
 * A site manager's or support's correction, ±N with a required note. Pass the site manager's
 * request so they are stamped as `createdBy`. `idempotencyKey` makes a retried form submit safe.
 */
export const adjustCredits = async (
  args: CreditHelperArgs & { delta: number; idempotencyKey?: string; note: string; organisation: ID },
): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slugs = slugsFor(args.payload)
  const organisation = await load(req, slugs.organisations, args.organisation)
  return recordMovement(
    { ...args, req },
    {
      delta: args.delta,
      idempotencyKey: args.idempotencyKey ?? null,
      note: args.note,
      organisation: organisation.id,
      reason: 'adjustment',
      tenant: tenantIDOf(organisation.tenant),
    },
  )
}

/** A legacy pack balance carried over by the import (PJ-65), once per legacy record. */
export const recordOpeningCredits = async (
  args: CreditHelperArgs & { credits: number; legacyRef: string; note?: string; organisation: ID },
): Promise<CreditWriteResult> => {
  const req = await requestFor(args)
  const slugs = slugsFor(args.payload)
  const organisation = await load(req, slugs.organisations, args.organisation)
  return recordMovement(
    { ...args, req },
    {
      delta: args.credits,
      legacyRef: args.legacyRef,
      note: args.note ?? null,
      organisation: organisation.id,
      reason: 'opening',
      tenant: tenantIDOf(organisation.tenant),
    },
  )
}

/** An organisation's credit balance: the sum of its rows. Never stored. */
export const balanceFor = async (args: CreditHelperArgs & { organisation: ID }): Promise<number> => {
  const req = await requestFor(args)
  return balanceInside(req, args.slug ?? creditLedgerSlugFor(args.payload), args.organisation)
}

/**
 * Jobs hook: a job cancelled before it was ever published gets its credit back, in the same
 * transaction as the cancellation. A job that used no credit is left alone.
 */
export const refundCreditOnCancel =
  ({ slug }: { slug?: string } = {}): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    if (operation !== 'update') return doc
    if (doc?.status !== 'cancelled' || previousDoc?.status === 'cancelled') return doc
    if (previousDoc?.publishedAt || doc?.publishedAt) return doc

    const ledger = slug ?? creditLedgerSlugFor(req.payload)
    if (!hasCollection(req, ledger)) return doc
    const state = await jobCreditState(req, ledger, doc.id)
    if (state.used === 0 || state.refunded >= state.used) return doc

    await refundCredit({ job: doc.id, payload: req.payload, req, slug: ledger })
    return doc
  }

// ---------------------------------------------------------------------------------------------
// History

export const HISTORY_JOB_EVENTS = [
  'posted',
  'draft',
  'waiting_for_purchase',
  'pending',
  'published',
  'expired',
  'cancelled',
  'relisted',
] as const
export type HistoryJobEvent = (typeof HISTORY_JOB_EVENTS)[number]

export type HistoryEntry = {
  at: string
  /** The running credit balance after this entry. */
  balance: number
  /** Who did it, when known (a credit row's `createdBy`, an order log's `by`). */
  by: null | { collection: null | string; id: ID }
  /** Credit change; `null` for order and job events. */
  delta: null | number
  /** `order`: created or the new status; `credit`: the reason; `job`: a `HistoryJobEvent`. */
  event: string
  /** The ledger row, for credit entries. */
  credit: null | { id: ID; legacyRef?: null | string; note: null | string; reason: CreditReason }
  job: null | { id: ID; status: null | string; title: null | string }
  kind: 'credit' | 'job' | 'order'
  order: null | { currency: null | string; id: ID; status: null | string; total: null | number }
}

export type OrganisationHistory = {
  entries: HistoryEntry[]
  organisation: ID
  /** Collection slugs, so a client can link each entry's order and job. */
  slugs: { jobs: string; ledger: string; orders: string }
  totals: {
    balance: number
    creditsIn: number
    creditsOut: number
    /** Orders not cancelled or failed, summed per currency, in minor units. */
    orders: { count: number; currency: string; total: number }[]
  }
}

type HistoryOrder = Record<string, unknown> & { id: ID }
type HistoryJob = Record<string, unknown> & { id: ID }

const KIND_ORDER: Record<HistoryEntry['kind'], number> = { credit: 2, job: 1, order: 0 }

const iso = (value: unknown): null | string => {
  if (typeof value !== 'string' && !(value instanceof Date)) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

const byOf = (value: unknown): HistoryEntry['by'] => {
  if (isRecord(value) && 'relationTo' in value) {
    const id = tenantIDOf(value.value)
    return id === null ? null : { collection: String(value.relationTo), id }
  }
  const id = tenantIDOf(value)
  return id === null ? null : { collection: null, id }
}

/**
 * One chronological list of an organisation's orders, credit movements and job events, with the
 * running credit balance on each entry and totals (pure: the endpoint loads the rows).
 *
 * Job events come from the job's own dates: posted (`createdAt`), published (`publishedAt`, the
 * latest listing), expired (`expiresAt`, once expired), cancelled (`updatedAt`, once cancelled)
 * and relisted (each later order that pays for the same job). Jobs keep no event log of their own
 * yet, so an earlier publication replaced by a relist shows as the relist.
 */
export const buildOrganisationHistory = ({
  includeStaffFields = false,
  jobs,
  ledger,
  orders,
  organisation,
  slugs = { jobs: DEFAULT_PAYLOAD_JOBS_SLUGS.jobs, ledger: CREDIT_LEDGER_SLUG, orders: DEFAULT_PAYLOAD_JOBS_SLUGS.orders },
}: {
  includeStaffFields?: boolean
  jobs: readonly HistoryJob[]
  ledger: readonly LedgerRow[]
  orders: readonly HistoryOrder[]
  organisation: ID
  slugs?: OrganisationHistory['slugs']
}): OrganisationHistory => {
  const jobsByID = new Map(jobs.map((job) => [String(job.id), job]))
  const ordersByID = new Map(orders.map((order) => [String(order.id), order]))
  type Draft = Omit<HistoryEntry, 'balance'> & { seq: string }
  const drafts: Draft[] = []

  const jobRef = (value: unknown): HistoryEntry['job'] => {
    const id = refKey(value)
    if (id === null) return null
    const job = jobsByID.get(id)
    return {
      id: tenantIDOf(value) as ID,
      status: typeof job?.status === 'string' ? job.status : null,
      title: typeof job?.title === 'string' ? job.title : null,
    }
  }
  const orderRef = (value: unknown): HistoryEntry['order'] => {
    const id = refKey(value)
    if (id === null) return null
    const order = ordersByID.get(id)
    return {
      currency: typeof order?.currency === 'string' ? order.currency : null,
      id: tenantIDOf(value) as ID,
      status: typeof order?.status === 'string' ? order.status : null,
      total: typeof order?.total === 'number' ? order.total : null,
    }
  }
  const base = { by: null, credit: null, delta: null, job: null, order: null } as const

  for (const row of ledger) {
    const at = iso(row.createdAt)
    if (at === null) continue
    drafts.push({
      ...base,
      at,
      by: byOf(row.createdBy),
      credit: {
        id: row.id,
        note: row.note ?? null,
        reason: row.reason,
        ...(includeStaffFields ? { legacyRef: row.legacyRef ?? null } : {}),
      },
      delta: row.delta,
      event: row.reason,
      job: jobRef(row.job),
      kind: 'credit',
      order: orderRef(row.order),
      seq: `credit:${String(row.id)}`,
    })
  }

  for (const order of orders) {
    const log = Array.isArray(order.log) ? order.log.filter(isRecord) : []
    const created = log.find((entry) => entry.event === 'created')
    const createdAt = iso(created?.at) ?? iso(order.createdAt)
    if (createdAt !== null) {
      drafts.push({ ...base, at: createdAt, by: byOf(created?.by), event: 'created', kind: 'order', order: orderRef(order.id), seq: `order:${String(order.id)}:0` })
    }
    log.forEach((entry, index) => {
      if (entry.event !== 'status') return
      const at = iso(entry.at)
      if (at === null) return
      drafts.push({ ...base, at, by: byOf(entry.by), event: String(entry.to), kind: 'order', order: orderRef(order.id), seq: `order:${String(order.id)}:${index + 1}` })
    })
  }

  // Orders that pay for each job, oldest first: the first is the listing, later ones relists.
  const ordersForJob = new Map<string, HistoryOrder[]>()
  // Sorts a copy; `toSorted` is ES2023, past this package's lib.
  // oxlint-disable-next-line unicorn/no-array-sort
  const ordersOldestFirst = [...orders].sort((a, b) => String(iso(a.createdAt)).localeCompare(String(iso(b.createdAt))))
  for (const order of ordersOldestFirst) {
    for (const jobID of [order.jobs].flat().map(refKey)) {
      if (jobID === null || !jobsByID.has(jobID)) continue
      ordersForJob.set(jobID, [...(ordersForJob.get(jobID) ?? []), order])
    }
  }

  for (const job of jobs) {
    const push = (event: HistoryJobEvent, value: unknown, extra: Partial<Draft> = {}) => {
      const at = iso(value)
      if (at === null) return
      drafts.push({ ...base, at, event, job: jobRef(job.id), kind: 'job', seq: `job:${String(job.id)}:${event}:${at}`, ...extra })
    }
    // The job's own log is the record of each move (PJ-32). A job from before the log has only
    // its dates, so those fill in whatever the log does not show.
    const log = Array.isArray(job.log) ? job.log.filter(isRecord) : []
    const seen = new Set<string>()
    log.forEach((entry, index) => {
      const event = entry.event === 'created' ? 'posted' : typeof entry.note === 'string' && entry.note.startsWith('Relisted as job ') ? 'relisted' : String(entry.to)
      if (!(HISTORY_JOB_EVENTS as readonly string[]).includes(event)) return
      seen.add(event)
      const by = entry.by === undefined || entry.by === null ? (event === 'posted' ? byOf(job.createdBy) : null) : byOf(entry.by)
      const at = iso(entry.at)
      if (at === null) return
      drafts.push({ ...base, at, by, event, job: jobRef(job.id), kind: 'job', seq: `job:${String(job.id)}:log:${index}` })
    })
    if (!seen.has('posted')) push('posted', job.createdAt, { by: byOf(job.createdBy) })
    if (!seen.has('published')) push('published', job.publishedAt)
    if (job.status === 'expired' && !seen.has('expired')) push('expired', job.expiresAt)
    if (job.status === 'cancelled' && !seen.has('cancelled')) push('cancelled', job.updatedAt)
    for (const order of (ordersForJob.get(String(job.id)) ?? []).slice(1)) {
      push('relisted', order.createdAt, { order: orderRef(order.id) })
    }
  }

  // Sorts the fresh array above.
  // oxlint-disable-next-line unicorn/no-array-sort
  drafts.sort((a, b) =>
    a.at !== b.at ? a.at.localeCompare(b.at) : a.kind !== b.kind ? KIND_ORDER[a.kind] - KIND_ORDER[b.kind] : a.seq.localeCompare(b.seq, 'en', { numeric: true }),
  )

  let balance = 0
  let creditsIn = 0
  let creditsOut = 0
  const entries: HistoryEntry[] = drafts.map(({ seq: _seq, ...entry }) => {
    if (entry.delta !== null) {
      balance = sumCreditDeltas([balance, entry.delta])
      if (entry.delta > 0) creditsIn += entry.delta
      else creditsOut -= entry.delta
    }
    return { ...entry, balance }
  })

  const orderTotals = new Map<string, { count: number; currency: string; total: number }>()
  for (const order of orders) {
    if (order.status === 'cancelled' || order.status === 'failed') continue
    if (typeof order.currency !== 'string' || typeof order.total !== 'number' || !Number.isSafeInteger(order.total)) continue
    const row = orderTotals.get(order.currency) ?? { count: 0, currency: order.currency, total: 0 }
    row.count += 1
    row.total += order.total
    if (!Number.isSafeInteger(row.total)) throw new CreditLedgerError('invalid', 'The order total is too large')
    orderTotals.set(order.currency, row)
  }

  return {
    entries,
    organisation,
    slugs,
    totals: {
      balance,
      creditsIn,
      creditsOut,
      // oxlint-disable-next-line unicorn/no-array-sort
      orders: [...orderTotals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
    },
  }
}

/** Whether `user` may see `organisation`'s history: super admins, its site managers, its members. */
export const canReadOrganisationHistory = (
  user: MissionControlUser | null,
  organisation: { id: ID; tenant?: unknown },
  tenantScoped: boolean,
): { allowed: boolean; staff: boolean } => {
  if (!user || isSeekerOnly(user)) return { allowed: false, staff: false }
  const tenantID = tenantScoped ? tenantIDOf(organisation.tenant) : null
  if (isStaffFor(user, tenantID, tenantScoped)) return { allowed: true, staff: true }
  const member =
    refKey(getUserOrganisationID(user)) === String(organisation.id) &&
    (tenantScoped
      ? tenantID !== null && hasTenantRole(user, tenantID, CREDIT_MEMBER_ROLES)
      : hasAnyTenantRole(user, CREDIT_MEMBER_ROLES))
  return { allowed: member, staff: false }
}

/** Load and build an organisation's history (`buildOrganisationHistory`) as system code. */
export const organisationHistory = async ({
  includeStaffFields = false,
  organisation,
  payload,
  req,
  slugs = slugsFor(payload),
}: {
  includeStaffFields?: boolean
  organisation: ID
  payload: Payload
  req?: PayloadRequest
  slugs?: PayloadJobsCollectionSlugs
}): Promise<OrganisationHistory> => {
  const request = req ?? (await createPayloadRequest({ payload }))
  const all = async (collection: string, where: Where) =>
    hasCollection(request, collection)
      ? ((
          await request.payload.find({
            collection: collection as CollectionSlug,
            depth: 0,
            overrideAccess: true,
            pagination: false,
            req: request,
            where,
          })
        ).docs as unknown as (Record<string, unknown> & { id: ID })[])
      : []

  const [ledger, orders, jobs] = await Promise.all([
    all(slugs.creditLedger, { organisation: { equals: organisation } }),
    all(slugs.orders, { organisation: { equals: organisation } }),
    all(slugs.jobs, { organisation: { equals: organisation } }),
  ])

  return buildOrganisationHistory({
    includeStaffFields,
    jobs,
    ledger: ledger as unknown as LedgerRow[],
    orders,
    organisation,
    slugs: { jobs: slugs.jobs, ledger: slugs.creditLedger, orders: slugs.orders },
  })
}

const notFound = (): Response => Response.json({ error: 'Not found' }, { status: 404 })

/**
 * `GET /api/<organisations>/:id/history`: the organisation's History tab data (admin and the
 * employer dashboard, PJ-82). Super admins, the organisation's site managers and its members
 * only; anyone else gets a 404, so the endpoint does not reveal which organisations exist.
 */
export const organisationHistoryEndpoint = ({
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
}: {
  slugs?: PayloadJobsCollectionSlugs
  tenantScoped?: boolean
} = {}): Endpoint => ({
  handler: async (req) => {
    const id = req.routeParams?.id
    const user = userOf(req)
    if (!user) return Response.json({ error: 'Sign in to see the history' }, { status: 401 })
    if (typeof id !== 'string' && typeof id !== 'number') return notFound()

    let organisation: { id: ID; tenant?: unknown }
    try {
      organisation = (await req.payload.findByID({
        collection: slugs.organisations as CollectionSlug,
        depth: 0,
        id,
        overrideAccess: true,
        req,
        select: { tenant: true } as never,
      })) as unknown as { id: ID; tenant?: unknown }
    } catch {
      return notFound()
    }

    const { allowed, staff } = canReadOrganisationHistory(user, organisation, tenantScoped)
    if (!allowed) return notFound()

    const history = await organisationHistory({
      includeStaffFields: staff,
      organisation: organisation.id,
      payload: req.payload,
      req,
      slugs,
    })
    return Response.json(history, { headers: { 'Cache-Control': 'private, no-store' } })
  },
  method: 'get',
  path: '/:id/history',
})

// ---------------------------------------------------------------------------------------------
// Collection

export type CreditLedgerCollectionOptions = {
  /** Overrides read and create access (PJ-80). Update and delete stay refused by the hooks. */
  access?: CollectionAccess
  slugs?: PayloadJobsCollectionSlugs
  /** `false` in single-tenant mode. */
  tenantScoped?: boolean
  /** The auth collection Payload stamps as `createdBy`. Defaults to `users`. */
  usersSlug?: string
}

export const creditLedgerCollection = ({
  access,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenantScoped = true,
}: CreditLedgerCollectionOptions = {}): CollectionConfig => {
  const staffRead = staffReadField(tenantScoped)
  const system = { create: systemOnlyField, update: () => false }
  const slug = slugs.creditLedger

  return {
    slug,
    access: mergeCollectionAccess(
      {
        create: creditLedgerCreateAccess(tenantScoped),
        delete: creditLedgerNoAccess,
        read: creditLedgerReadAccess(tenantScoped),
        update: creditLedgerNoAccess,
      },
      access,
    ),
    admin: {
      defaultColumns: ['createdAt', 'organisation', 'reason', 'delta', 'job', 'order', 'note'],
      description:
        'Every credit movement, oldest to newest. Rows never change: correct a mistake with an adjustment. The balance is the sum of an organisation’s rows.',
      group: 'Job board',
    },
    defaultSort: '-createdAt',
    fields: [
      {
        name: 'organisation',
        type: 'relationship',
        index: true,
        relationTo: slugs.organisations as CollectionSlug,
        required: true,
      },
      {
        type: 'row',
        fields: [
          {
            name: 'delta',
            type: 'number',
            required: true,
            validate: (value: null | number | undefined) =>
              isCreditDelta(value) ? true : 'Use a whole number of credits other than 0',
            admin: { description: 'Credits added (+) or taken (−).', step: 1 },
          },
          {
            name: 'reason',
            type: 'select',
            defaultValue: 'adjustment',
            index: true,
            options: CREDIT_REASONS.map((value) => ({ label: CREDIT_REASON_LABELS[value], value })),
            required: true,
          },
        ],
      },
      {
        name: 'note',
        type: 'textarea',
        admin: { description: 'Why. Required for an adjustment.' },
      },
      {
        type: 'row',
        fields: [
          { name: 'order', type: 'relationship', access: system, index: true, relationTo: slugs.orders as CollectionSlug },
          { name: 'job', type: 'relationship', access: system, index: true, relationTo: slugs.jobs as CollectionSlug },
        ],
      },
      {
        name: 'actor',
        type: 'select',
        access: system,
        options: CREDIT_ACTORS.map((value) => ({ label: value, value })),
        admin: { position: 'sidebar', readOnly: true },
      },
      {
        name: 'legacyRef',
        type: 'text',
        access: { ...system, read: staffRead },
        index: true,
        admin: { description: 'The WordPress record an opening balance came from (PJ-65).', position: 'sidebar', readOnly: true },
      },
      {
        name: 'idempotencyKey',
        type: 'text',
        access: { ...system, read: staffRead },
        unique: true,
        admin: { description: 'Makes a movement happen once. Filled in automatically.', position: 'sidebar', readOnly: true },
      },
    ],
    hooks: {
      beforeChange: [creditLedgerRules({ slug, slugs, tenantScoped })],
      beforeDelete: [refuseCreditLedgerDelete],
    },
    labels: { plural: 'Credit ledger', singular: 'Credit movement' },
    timestamps: true,
    versions: false,
  }
}
