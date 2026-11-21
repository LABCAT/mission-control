/**
 * An in-memory Xero Accounting API for tests: contacts, invoices, online invoice links and the
 * `Idempotency-Key` behaviour, behind a `fetch` the sync uses instead of the network. Tests
 * never reach Xero.
 */

type Json = Record<string, any>

export type FakeCall = {
  body?: Json
  idempotencyKey: null | string
  method: string
  path: string
  /** The `xero-tenant-id` header: which Xero organisation the call was for. */
  xeroTenantId: null | string
}

/** Answer the next matching call yourself (a failure, a lost response...). */
export type FakeFault = {
  match: (call: FakeCall) => boolean
  /** `'after'`: let Xero do the work, then fail on the way back (a lost answer). */
  when?: 'after' | 'before'
  respond: () => Response
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export class FakeXero {
  calls: FakeCall[] = []
  contacts: Json[] = []
  faults: FakeFault[] = []
  invoices = new Map<string, Json & { org: string }>()
  /** Total Xero reports, by invoice id, when a test wants it to disagree. */
  totalOverride = new Map<string, number>()
  private idempotent = new Map<string, Response>()
  private next = 1

  /** Invoices of one organisation. */
  invoicesOf(org: string): Json[] {
    return [...this.invoices.values()].filter((invoice) => invoice.org === org)
  }

  private total(invoice: Json): number {
    const override = this.totalOverride.get(invoice.InvoiceID)
    if (override !== undefined) return override

    let total = 0
    for (const line of invoice.LineItems ?? []) total += line.Quantity * line.UnitAmount - (line.DiscountAmount ?? 0)
    return Math.round(total * 10_000) / 10_000
  }

  private view(invoice: Json): Json {
    const { org: _org, ...rest } = invoice
    return { ...rest, Total: this.total(invoice) }
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    const call: FakeCall = {
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      idempotencyKey: headers.get('idempotency-key'),
      method: init?.method ?? 'GET',
      path: `${url.pathname.replace(/^\/api\.xro\/2\.0/, '')}${url.search}`,
      xeroTenantId: headers.get('xero-tenant-id'),
    }
    this.calls.push(call)

    if (headers.get('authorization') !== 'Bearer test-access-token') return json({ Detail: 'Unauthorised' }, 401)

    const faultIndex = this.faults.findIndex((fault) => fault.match(call))
    const fault = faultIndex === -1 ? undefined : this.faults.splice(faultIndex, 1)[0]
    if (fault && fault.when !== 'after') return fault.respond()

    const response = this.handle(call)
    return fault ? fault.respond() : response
  }

  private handle(call: FakeCall): Response {
    const org = call.xeroTenantId ?? ''
    const [path, query = ''] = call.path.split('?')
    const params = new URLSearchParams(query)

    if (call.idempotencyKey) {
      const seen = this.idempotent.get(`${org}:${call.idempotencyKey}`)
      if (seen) return seen.clone()
    }
    const remember = (response: Response): Response => {
      if (call.idempotencyKey) this.idempotent.set(`${org}:${call.idempotencyKey}`, response.clone())
      return response
    }

    if (call.method === 'GET' && path === '/Contacts') {
      const where = params.get('where') ?? ''
      const [, field, value] = /^(\w+)=="(.*)"$/.exec(where) ?? []
      return json({ Contacts: this.contacts.filter((c) => c.org === org && c[field!] === value) })
    }
    if ((call.method === 'POST' || call.method === 'PUT') && path === '/Contacts') {
      const contact = { ContactID: uuid(this.next++), ContactStatus: 'ACTIVE', org, ...call.body!.Contacts[0] }
      this.contacts.push(contact)
      return json({ Contacts: [contact] })
    }

    if (call.method === 'GET' && path === '/Invoices') {
      const where = params.get('where') ?? ''
      const reference = /Reference=="(.*)"/.exec(where)?.[1]
      const statuses = (params.get('Statuses') ?? '').split(',')
      return json({
        Invoices: this.invoicesOf(org)
          .filter((invoice) => invoice.Reference?.toLowerCase() === reference?.toLowerCase())
          .filter((invoice) => statuses.includes(invoice.Status))
          .map((invoice) => this.view(invoice)),
      })
    }
    if (call.method === 'PUT' && path === '/Invoices') {
      const input = call.body!.Invoices[0]
      const contact = this.contacts.find((c) => c.ContactID === input.Contact.ContactID && c.org === org)
      if (!contact) return json({ Elements: [{ ValidationErrors: [{ Message: 'Contact not found' }] }] }, 400)
      const id = uuid(this.next++)
      const invoice = {
        ...input,
        DateString: '2026-11-21T00:00:00',
        InvoiceID: id,
        InvoiceNumber: `INV-${String(this.next).padStart(4, '0')}`,
        org,
      }
      this.invoices.set(id, invoice)
      return remember(json({ Invoices: [this.view(invoice)] }))
    }

    const one = /^\/Invoices\/([0-9a-f-]{36})(\/OnlineInvoice)?$/.exec(path)
    if (one) {
      const invoice = this.invoices.get(one[1]!)
      if (!invoice || invoice.org !== org) return json({ Detail: 'Not found' }, 404)

      if (one[2]) {
        if (invoice.Status === 'DRAFT') return json({ Detail: 'Draft invoices have no online link' }, 400)
        return json({ OnlineInvoices: [{ OnlineInvoiceUrl: `https://in.xero.com/${invoice.InvoiceID}` }] })
      }
      if (call.method === 'GET') return json({ Invoices: [this.view(invoice)] })
      if (call.method === 'POST') {
        Object.assign(invoice, call.body!.Invoices[0])
        return remember(json({ Invoices: [this.view(invoice)] }))
      }
    }

    return json({ Detail: `fake Xero has no ${call.method} ${call.path}` }, 404)
  }
}

export const unavailable = (): Response => json({ Detail: 'Service unavailable' }, 503)
export const rejected = (message: string): Response =>
  json({ Elements: [{ ValidationErrors: [{ Message: message }] }] }, 400)
export const networkError = (): Response => {
  throw new TypeError('fetch failed')
}
