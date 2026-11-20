import { describe, expect, it, vi } from 'vitest'

import {
  classifyInvoice,
  fetchXeroInvoices,
  parseXeroDate,
  syncInvoicePayments,
  XERO_INVOICE_BATCH_SIZE,
  XeroPaymentSyncError,
  xeroPaymentSyncTask,
  XERO_PAYMENT_SYNC_CRON,
  XERO_PAYMENT_SYNC_QUEUE,
  type InvoiceOrderStore,
  type OpenInvoiceOrder,
  type XeroInvoice,
} from './payment-sync'

const NOW = new Date('2026-11-20T12:00:00Z')
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status: 200, ...init })

const invoice = (n: number, extra: Partial<XeroInvoice> = {}): XeroInvoice => ({
  AmountDue: 100,
  AmountPaid: 0,
  InvoiceID: id(n),
  Status: 'AUTHORISED',
  ...extra,
})

const fakeStore = (orders: OpenInvoiceOrder[], flagged: Set<number | string> = new Set(), trackOverdue = true) => {
  const calls = {
    cancelled: [] as (number | string)[],
    overdue: [] as [number | string, boolean][],
    paid: [] as [number | string, unknown][],
  }
  const store: InvoiceOrderStore = {
    listOpenOrders: async () => orders,
    markCancelled: async (order) => void calls.cancelled.push(order.orderId),
    markPaid: async (order, details) => void calls.paid.push([order.orderId, details]),
    ...(trackOverdue
      ? {
          overdue: {
            isFlaggedOverdue: (order: OpenInvoiceOrder) => flagged.has(order.orderId),
            setOverdue: async (order: OpenInvoiceOrder, value: boolean) => {
              calls.overdue.push([order.orderId, value])
              if (value) flagged.add(order.orderId)
              else flagged.delete(order.orderId)
            },
          },
        }
      : {}),
  }

  return { calls, store }
}

const api = (fetch: typeof globalThis.fetch) => ({
  accessToken: 'token',
  fetch,
  minIntervalMs: 0,
  sleep: async () => {},
  tenantId: 'xero-org',
})

describe('parseXeroDate', () => {
  it('reads .NET and ISO dates and refuses junk', () => {
    expect(parseXeroDate('/Date(1763640000000+0000)/')?.toISOString()).toBe('2025-11-20T12:00:00.000Z')
    expect(parseXeroDate('2026-11-20T00:00:00')).toBeInstanceOf(Date)
    expect(parseXeroDate('nope')).toBeNull()
    expect(parseXeroDate(null)).toBeNull()
  })
})

describe('classifyInvoice', () => {
  it('treats PAID as paid, VOIDED and DELETED as cancelled', () => {
    expect(classifyInvoice(invoice(1, { Status: 'PAID' }), NOW)).toBe('paid')
    expect(classifyInvoice(invoice(1, { Status: 'VOIDED' }), NOW)).toBe('cancelled')
    expect(classifyInvoice(invoice(1, { Status: 'DELETED' }), NOW)).toBe('cancelled')
  })

  it('flags an authorised invoice as overdue only after its due day has ended and while money is owed', () => {
    const due = (iso: string, extra: Partial<XeroInvoice> = {}) =>
      classifyInvoice(invoice(1, { DueDateString: iso, ...extra }), NOW)

    expect(due('2026-11-19T00:00:00')).toBe('overdue')
    expect(due('2026-11-20T00:00:00')).toBe('open') // due today: not overdue until the day is over
    expect(due('2026-12-01T00:00:00')).toBe('open')
    expect(due('2026-11-01T00:00:00', { AmountDue: 0 })).toBe('open')
  })

  it('keeps drafts and submitted invoices open even when the due date has passed', () => {
    expect(classifyInvoice(invoice(1, { DueDateString: '2020-01-01T00:00:00', Status: 'DRAFT' }), NOW)).toBe('open')
    expect(classifyInvoice(invoice(1, { DueDateString: '2020-01-01T00:00:00', Status: 'SUBMITTED' }), NOW)).toBe('open')
  })
})

describe('fetchXeroInvoices @S-096', () => {
  it('sends the tenant header and the bearer token, read-only, and only well-formed ids', async () => {
    const fetch = vi.fn(async () => json({ Invoices: [invoice(1)] }))
    const result = await fetchXeroInvoices({ ...api(fetch as never), invoiceIds: [id(1), 'x"; drop', id(1)] })

    expect(result.get(id(1))?.Status).toBe('AUTHORISED')
    expect(fetch).toHaveBeenCalledTimes(1)

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.xero.com/api.xro/2.0/Invoices?IDs=${id(1)}`)
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ authorization: 'Bearer token', 'xero-tenant-id': 'xero-org' })
  })

  it('splits a long list into batches with a pause between calls', async () => {
    const ids = Array.from({ length: XERO_INVOICE_BATCH_SIZE + 5 }, (_, index) => id(index + 1))
    const fetch = vi.fn(async () => json({ Invoices: [] }))
    const sleep = vi.fn(async () => {})

    await fetchXeroInvoices({ ...api(fetch as never), invoiceIds: ids, minIntervalMs: 1000, sleep })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('waits out a 429 using Retry-After and then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { headers: { 'retry-after': '7' }, status: 429 }))
      .mockResolvedValueOnce(json({ Invoices: [invoice(1)] }))
    const sleep = vi.fn(async () => {})

    const result = await fetchXeroInvoices({ ...api(fetch as never), invoiceIds: [id(1)], sleep })

    expect(result.size).toBe(1)
    expect(sleep).toHaveBeenCalledWith(7000)
  })

  it('gives up after three attempts and never puts the token in the error', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }))

    const error = await fetchXeroInvoices({ ...api(fetch as never), invoiceIds: [id(1)] }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(XeroPaymentSyncError)
    expect((error as XeroPaymentSyncError).code).toBe('invoice_lookup_failed')
    expect((error as Error).message).not.toContain('token')
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 401', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 }))

    await expect(fetchXeroInvoices({ ...api(fetch as never), invoiceIds: [id(1)] })).rejects.toMatchObject({
      code: 'invoice_lookup_failed',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('refuses to run without a token or organisation', async () => {
    await expect(
      fetchXeroInvoices({ ...api(vi.fn() as never), accessToken: ' ', invoiceIds: [id(1)] }),
    ).rejects.toMatchObject({ code: 'not_connected' })
  })
})

describe('syncInvoicePayments @S-096', () => {
  const orders: OpenInvoiceOrder[] = [1, 2, 3, 4, 5].map((n) => ({ invoiceId: id(n), orderId: n }))

  const xero = (invoices: XeroInvoice[]) => vi.fn(async () => json({ Invoices: invoices }))

  it('marks paid, cancels voided, flags overdue and ignores missing and open invoices', async () => {
    const { calls, store } = fakeStore(orders)
    const fetch = xero([
      invoice(1, { AmountPaid: 3900, FullyPaidOnDateString: '2026-11-18T00:00:00', Status: 'PAID' }),
      invoice(2, { Status: 'VOIDED' }),
      invoice(3, { DueDateString: '2026-11-01T00:00:00' }),
      invoice(4, { DueDateString: '2027-01-01T00:00:00' }),
      // order 5: Xero returns nothing
    ])

    const result = await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(result).toEqual({ cancelled: 1, checked: 5, failed: [], missing: 1, overdue: 1, paid: 1 })
    expect(calls.paid).toEqual([[1, { amountPaid: 3900, paidAt: new Date('2026-11-18T00:00:00') }]])
    expect(calls.cancelled).toEqual([2])
    expect(calls.overdue).toEqual([[3, true]])
  })

  it('is read-only: it only ever issues GET requests', async () => {
    const { store } = fakeStore(orders)
    const fetch = xero([invoice(1, { Status: 'PAID' })])

    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][]) {
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
    }
  })

  it('is idempotent: a second run over the same Xero data does not repeat the overdue flag', async () => {
    const { calls, store } = fakeStore(orders.slice(2, 3))
    const fetch = xero([invoice(3, { DueDateString: '2026-11-01T00:00:00' })])

    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })
    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(calls.overdue).toEqual([[3, true]])
  })

  it('never repeats the overdue update for a host that does not track the flag', async () => {
    const { calls, store } = fakeStore(orders.slice(2, 3), new Set(), false)
    const fetch = xero([invoice(3, { DueDateString: '2026-11-01T00:00:00' })])

    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(calls.overdue).toEqual([])
  })

  it('clears the overdue flag when the invoice is no longer overdue', async () => {
    const { calls, store } = fakeStore(orders.slice(3, 4), new Set([4]))
    const fetch = xero([invoice(4, { DueDateString: '2027-01-01T00:00:00' })])

    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(calls.overdue).toEqual([[4, false]])
  })

  it('keeps going when one order handler throws, and records which one', async () => {
    const { calls, store } = fakeStore(orders.slice(0, 2))
    store.markPaid = async (order) => {
      if (order.orderId === 1) throw new Error('job release failed')
      calls.paid.push([order.orderId, null])
    }
    const fetch = xero([invoice(1, { Status: 'PAID' }), invoice(2, { Status: 'PAID' })])

    const result = await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(result.paid).toBe(1)
    expect(result.failed).toEqual([{ error: 'job release failed', orderId: 1 }])
    expect(calls.paid.map(([orderId]) => orderId)).toEqual([2])
  })

  it('does not call Xero when there are no open orders', async () => {
    const { store } = fakeStore([])
    const fetch = xero([])

    const result = await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(result.checked).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('matches invoice ids regardless of case', async () => {
    const upper = { invoiceId: id(1).toUpperCase(), orderId: 1 }
    const { calls, store } = fakeStore([upper])
    const fetch = xero([invoice(1, { Status: 'PAID' })])

    await syncInvoicePayments({ ...api(fetch as never), now: NOW, store })

    expect(calls.paid).toHaveLength(1)
  })
})

describe('xeroPaymentSyncTask @S-096', () => {
  it('is scheduled hourly on the queue the CMS Worker runs', () => {
    const task = xeroPaymentSyncTask({ oauth: {}, orders: () => fakeStore([]).store })

    expect(task.slug).toBe('xero-payment-sync')
    expect(XERO_PAYMENT_SYNC_CRON.split(' ')).toHaveLength(6)
    // `apps/cms/src/jobs/runScheduled.ts` runs only `SCHEDULED_QUEUES`; anything else never fires.
    expect(XERO_PAYMENT_SYNC_QUEUE).toBe('hourly')
    expect(task.schedule).toEqual([{ cron: XERO_PAYMENT_SYNC_CRON, queue: 'hourly' }])
  })

  it('skips an organisation that never connected Xero', async () => {
    const orders = vi.fn(() => fakeStore([]).store)
    const payload = {
      find: vi.fn(async () => ({ docs: [{ id: 1 }] })),
      findByID: vi.fn(async () => ({ id: 1, tokens: null, xeroTenantId: null })),
      logger: { error: vi.fn() },
    }
    const task = xeroPaymentSyncTask({ oauth: {}, orders })

    const out = await (task.handler as unknown as (a: unknown) => Promise<{ output: Record<string, number> }>)({
      req: { payload },
    })

    expect(out.output).toMatchObject({ failed: 0, organisations: 0, paid: 0 })
    expect(orders).not.toHaveBeenCalled()
  })

  it('records an unreadable settings row and keeps going with the next organisation', async () => {
    const findByID = vi.fn(async ({ id: rowId }: { id: number | string }) => {
      if (rowId === 1) throw new Error('db down')
      return { id: rowId, tokens: null, xeroTenantId: null }
    })
    const payload = {
      find: vi.fn(async () => ({ docs: [{ id: 1 }, { id: 2 }] })),
      findByID,
      logger: { error: vi.fn() },
    }
    const task = xeroPaymentSyncTask({ oauth: {}, orders: () => fakeStore([]).store })

    const out = await (task.handler as unknown as (a: unknown) => Promise<{ output: Record<string, number> }>)({
      req: { payload },
    })

    expect(out.output).toMatchObject({ failed: 1, organisations: 0 })
    expect(findByID).toHaveBeenCalledTimes(2)
    expect(payload.logger.error).toHaveBeenCalledTimes(1)
  })
})
