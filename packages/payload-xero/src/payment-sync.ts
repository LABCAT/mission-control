/**
 * Xero payment sync (PJ-118): read the status of the invoices behind open orders and tell the
 * host app which ones were paid, voided or are overdue.
 *
 * Read-only: nothing here ever creates a payment in Xero. The host app owns its orders, so the
 * sync talks to them through an `InvoiceOrderStore` and the package keeps no dependency on any
 * orders collection. Every step is idempotent: an order that is already paid or cancelled is not
 * offered again, and a second run over the same Xero data changes nothing.
 *
 * `fetch` only, with Xero's `xero-tenant-id` header, so this runs on Cloudflare Workers.
 */
import type { Payload, TaskConfig } from 'payload'

import { XERO_API_BASE_URL, XERO_API_TIMEOUT_MS, type XeroApiArgs } from './contacts'
import {
  findSettingsWithTokens,
  getXeroAccessToken,
  type XeroSettingsDoc,
} from './token-store'
import type { XeroOAuthOptions } from './oauth'

/** Xero allows 60 calls a minute per organisation; one call a second stays under that. */
export const XERO_MIN_INTERVAL_MS = 1_000
/** Invoice IDs per `GET /Invoices?IDs=`: keeps the URL well under Xero's limits. */
export const XERO_INVOICE_BATCH_SIZE = 40
export const XERO_MAX_ATTEMPTS = 3
/** Longest we will wait on a `Retry-After`, so one busy tenant cannot hold a job open. */
export const XERO_MAX_RETRY_WAIT_MS = 30_000
/** Hourly, six fields with seconds first (Payload's scheduler). */
export const XERO_PAYMENT_SYNC_CRON = '0 0 * * * *'
export const XERO_PAYMENT_SYNC_TASK_SLUG = 'xero-payment-sync'
/** The queue the CMS Worker actually runs each cron tick (see `apps/cms/src/jobs/runScheduled.ts`). */
export const XERO_PAYMENT_SYNC_QUEUE = 'hourly'

export type XeroPaymentSyncErrorCode = 'invoice_lookup_failed' | 'not_connected'

/** A sync failure with a stable `code`. Never holds a token. */
export class XeroPaymentSyncError extends Error {
  readonly code: XeroPaymentSyncErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: XeroPaymentSyncErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'XeroPaymentSyncError'
    this.code = code
    this.details = details
  }
}

/** The part of a Xero invoice the sync reads. */
export type XeroInvoice = {
  AmountDue?: null | number
  AmountPaid?: null | number
  /** .NET date (`/Date(ms+0000)/`) as Xero spells it in JSON. */
  DueDate?: null | string
  DueDateString?: null | string
  FullyPaidOnDate?: null | string
  FullyPaidOnDateString?: null | string
  InvoiceID: string
  Status?: null | string
  Total?: null | number
}

export type InvoiceVerdict = 'cancelled' | 'open' | 'overdue' | 'paid'

/** An order with a Xero invoice that is still waiting for payment. */
export type OpenInvoiceOrder = {
  /** The Xero `InvoiceID` stored on the order. */
  invoiceId: string
  orderId: number | string
}

export type PaidDetails = {
  /** Total paid in the invoice currency's major units, as Xero reports it. */
  amountPaid: null | number
  /** When Xero says the invoice was fully paid, if it says. */
  paidAt: Date | null
}

/**
 * How the sync reaches the host app's orders. The host decides what "paid" means for its jobs:
 * it appends the history event, sends the "order paid" email and releases any job waiting on
 * payment (respecting the organisation's trusted flag and moderation).
 */
export type InvoiceOrderStore = {
  /** Orders still waiting for payment that have a Xero invoice. */
  listOpenOrders: () => Promise<OpenInvoiceOrder[]>
  /** Order → Cancelled for a voided or deleted invoice. Its job is not released. */
  markCancelled: (order: OpenInvoiceOrder, invoice: XeroInvoice) => Promise<void>
  /** Order → Paid. */
  markPaid: (order: OpenInvoiceOrder, details: PaidDetails) => Promise<void>
  /** Keep the admin "overdue" flag in step with Xero. Called only when the flag should change. */
  setOverdue?: (order: OpenInvoiceOrder, overdue: boolean) => Promise<void>
  /** Orders currently flagged overdue, so a later payment clears the flag. Optional. */
  isFlaggedOverdue?: (order: OpenInvoiceOrder) => boolean
}

export type SyncSleep = (ms: number) => Promise<void>

export type FetchInvoicesArgs = XeroApiArgs & {
  invoiceIds: string[]
  /** Spacing between calls. Defaults to one second. */
  minIntervalMs?: number
  /** Waits; tests pass a fake. Defaults to a timer. */
  sleep?: SyncSleep
}

const defaultSleep: SyncSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Parse Xero's .NET JSON date, or an ISO string. */
export const parseXeroDate = (value: null | string | undefined): Date | null => {
  if (typeof value !== 'string' || !value) return null

  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value)
  const date = dotNet ? new Date(Number(dotNet[1])) : new Date(value)

  return Number.isNaN(date.getTime()) ? null : date
}

const isInvoice = (value: unknown): value is XeroInvoice =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { InvoiceID?: unknown }).InvoiceID === 'string' &&
  Boolean((value as { InvoiceID: string }).InvoiceID)

const retryAfterMs = (response: Response): number => {
  const seconds = Number(response.headers.get('retry-after'))

  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, XERO_MAX_RETRY_WAIT_MS)
    : 5_000
}

/**
 * Fetch the invoices for these IDs, in batches, one call at a time. A 429 or 5xx is retried
 * (honouring `Retry-After`) up to three times; anything else throws `invoice_lookup_failed`.
 * IDs Xero does not return are simply absent from the result.
 */
export const fetchXeroInvoices = async ({
  accessToken,
  apiBaseUrl = XERO_API_BASE_URL,
  fetch = globalThis.fetch,
  invoiceIds,
  minIntervalMs = XERO_MIN_INTERVAL_MS,
  sleep = defaultSleep,
  tenantId,
  timeoutMs = XERO_API_TIMEOUT_MS,
}: FetchInvoicesArgs): Promise<Map<string, XeroInvoice>> => {
  const result = new Map<string, XeroInvoice>()

  if (!accessToken.trim() || !tenantId.trim()) {
    throw new XeroPaymentSyncError('not_connected', 'Connect Xero for this tenant before syncing payments.')
  }

  // Only well-formed IDs go into a URL; a malformed stored value cannot widen the query.
  const ids = [...new Set(invoiceIds.filter((id) => GUID.test(id)))]

  for (let start = 0; start < ids.length; start += XERO_INVOICE_BATCH_SIZE) {
    if (start > 0) await sleep(minIntervalMs)

    const batch = ids.slice(start, start + XERO_INVOICE_BATCH_SIZE)
    const path = `/Invoices?${new URLSearchParams({ IDs: batch.join(',') }).toString()}`

    for (let attempt = 1; ; attempt += 1) {
      let response: Response
      try {
        response = await fetch(`${apiBaseUrl}${path}`, {
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
            'xero-tenant-id': tenantId,
          },
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        if (attempt < XERO_MAX_ATTEMPTS) {
          await sleep(minIntervalMs * attempt)
          continue
        }

        throw new XeroPaymentSyncError('invoice_lookup_failed', 'Could not reach Xero.', {
          cause: error instanceof Error ? error.name : 'network_error',
        })
      }

      if ((response.status === 429 || response.status >= 500) && attempt < XERO_MAX_ATTEMPTS) {
        await sleep(response.status === 429 ? retryAfterMs(response) : minIntervalMs * attempt)
        continue
      }

      if (!response.ok) {
        throw new XeroPaymentSyncError(
          'invoice_lookup_failed',
          `Xero refused the invoice request (HTTP ${response.status}).`,
          { status: response.status },
        )
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = undefined
      }

      const invoices = (body as { Invoices?: unknown } | null | undefined)?.Invoices
      if (!Array.isArray(invoices)) {
        throw new XeroPaymentSyncError('invoice_lookup_failed', 'Xero returned an unreadable invoices response.')
      }

      for (const invoice of invoices) {
        if (isInvoice(invoice)) result.set(invoice.InvoiceID.toLowerCase(), invoice)
      }

      break
    }
  }

  return result
}

/**
 * What an invoice means for its order. PAID wins over everything; VOIDED and DELETED cancel;
 * an AUTHORISED invoice past its due date with something still owing is overdue. DRAFT and
 * SUBMITTED invoices are not yet owed, so they stay open.
 */
export const classifyInvoice = (invoice: XeroInvoice, now: Date = new Date()): InvoiceVerdict => {
  const status = (invoice.Status ?? '').toUpperCase()

  if (status === 'PAID') return 'paid'
  if (status === 'VOIDED' || status === 'DELETED') return 'cancelled'

  if (status === 'AUTHORISED') {
    const due = parseXeroDate(invoice.DueDateString ?? invoice.DueDate)
    const owing = typeof invoice.AmountDue === 'number' ? invoice.AmountDue > 0 : true

    // Xero dates carry no time: an invoice due today is due until the day is over.
    if (due && owing && due.getTime() + 24 * 60 * 60 * 1000 <= now.getTime()) return 'overdue'
  }

  return 'open'
}

export type PaymentSyncResult = {
  cancelled: number
  /** Orders whose handler threw. The rest of the run is unaffected. */
  failed: { error: string; orderId: number | string }[]
  /** Orders whose invoice Xero did not return. Nothing is changed for them. */
  missing: number
  overdue: number
  paid: number
  /** Orders looked at. */
  checked: number
}

export type SyncInvoicePaymentsArgs = XeroApiArgs & {
  minIntervalMs?: number
  now?: Date
  sleep?: SyncSleep
  store: InvoiceOrderStore
}

/**
 * One sync pass for one Xero organisation. A failing order handler is recorded and the pass
 * carries on, so one bad order cannot stop every other tenant order from being released.
 */
export const syncInvoicePayments = async ({
  now = new Date(),
  store,
  ...api
}: SyncInvoicePaymentsArgs): Promise<PaymentSyncResult> => {
  const result: PaymentSyncResult = { cancelled: 0, checked: 0, failed: [], missing: 0, overdue: 0, paid: 0 }
  const orders = await store.listOpenOrders()

  if (orders.length === 0) return result

  const invoices = await fetchXeroInvoices({ ...api, invoiceIds: orders.map((order) => order.invoiceId) })

  for (const order of orders) {
    result.checked += 1

    const invoice = invoices.get(order.invoiceId.toLowerCase())
    if (!invoice) {
      result.missing += 1
      continue
    }

    try {
      const verdict = classifyInvoice(invoice, now)

      if (verdict === 'paid') {
        await store.markPaid(order, {
          amountPaid: typeof invoice.AmountPaid === 'number' ? invoice.AmountPaid : null,
          paidAt: parseXeroDate(invoice.FullyPaidOnDateString ?? invoice.FullyPaidOnDate),
        })
        result.paid += 1
      } else if (verdict === 'cancelled') {
        await store.markCancelled(order, invoice)
        result.cancelled += 1
      } else {
        const overdue = verdict === 'overdue'
        if (overdue) result.overdue += 1

        if (store.setOverdue && (store.isFlaggedOverdue?.(order) ?? false) !== overdue) {
          await store.setOverdue(order, overdue)
        }
      }
    } catch (error) {
      result.failed.push({
        error: error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
        orderId: order.orderId,
      })
    }
  }

  return result
}

export type XeroPaymentSyncTaskOptions = {
  /** Settings collection slug. Defaults to `xero-settings`. */
  collection?: string
  /** Current time, for tests. */
  now?: () => Date
  /** OAuth options: credentials, `fetch`, encryption key. */
  oauth: XeroOAuthOptions
  /** The host app's orders for one connected settings row (one Xero organisation). */
  orders: (args: { payload: Payload; settings: XeroSettingsDoc }) => InvoiceOrderStore
  /** Task slug. Defaults to `xero-payment-sync`. */
  slug?: string
}

/**
 * A Payload task that runs the sync for every connected Xero organisation, hourly. Register it
 * in `jobs.tasks`; the schedule queues it for the next matching time and a later tick runs it.
 * Tenants that never connected Xero are skipped.
 */
export const xeroPaymentSyncTask = (options: XeroPaymentSyncTaskOptions): TaskConfig<never> => {
  const collection = options.collection ?? 'xero-settings'
  const slug = options.slug ?? XERO_PAYMENT_SYNC_TASK_SLUG

  return {
    slug,
    // mission-control: hourly, seconds first, and on the queue the Worker actually runs. A task on a
    // queue no cron tick runs never fires, so keep this in step with `SCHEDULED_QUEUES`.
    schedule: [{ cron: XERO_PAYMENT_SYNC_CRON, queue: XERO_PAYMENT_SYNC_QUEUE }],
    handler: async ({ req }: { req: { payload: Payload } }) => {
      const { payload } = req
      const rows = await payload.find({
        collection: collection as never,
        depth: 0,
        limit: 1000,
        overrideAccess: true,
        pagination: false,
      })

      const totals = { cancelled: 0, failed: 0, organisations: 0, overdue: 0, paid: 0 }

      for (const row of rows.docs as unknown as { id: number | string }[]) {
        const settings = await findSettingsWithTokens({ collection, id: row.id, payload })
        if (!settings?.xeroTenantId || !settings.tokens) continue

        try {
          const { accessToken } = await getXeroAccessToken({
            collection,
            ...(options.now ? { now: options.now().getTime() } : {}),
            oauth: options.oauth,
            payload,
            settings,
          })

          const result = await syncInvoicePayments({
            accessToken,
            ...(options.now ? { now: options.now() } : {}),
            ...(options.oauth.fetch ? { fetch: options.oauth.fetch } : {}),
            store: options.orders({ payload, settings }),
            tenantId: settings.xeroTenantId,
          })

          totals.organisations += 1
          totals.paid += result.paid
          totals.cancelled += result.cancelled
          totals.overdue += result.overdue
          totals.failed += result.failed.length
        } catch (error) {
          // One organisation failing (revoked token, Xero down) must not stop the others.
          totals.failed += 1
          payload.logger.error(
            { code: (error as { code?: string }).code ?? 'unknown', settingsId: settings.id },
            'xero payment sync failed for one organisation',
          )
        }
      }

      return { output: totals }
    },
  } as unknown as TaskConfig<never>
}
