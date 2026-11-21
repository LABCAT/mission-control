/**
 * Orders → Xero invoices (PJ-57): the payload-jobs side of payload-xero's invoice adapter.
 *
 * payload-xero stays generic: it only sees the neutral invoice this module builds. The rules
 * that are about orders live here:
 *
 * - an order is invoiced when it is paid by invoice, totals above 0, is `pending`, `invoiced`
 *   or `paid`, and is not a legacy import (those already have their WordPress-era invoice);
 * - a purchase request (`waiting_for_purchase`) gets no invoice until the owner approves it;
 * - the invoice is a draft until checkout completes (`invoiced` or `paid`), then authorised,
 *   unless the tenant's Xero settings keep invoices as drafts;
 * - lines come from the order's frozen quote: the plan, each paid add-on, and the discounts,
 *   on the account codes in the tenant's Xero settings. Money stays in minor units.
 */
import type { CollectionSlug, Payload, PayloadRequest } from 'payload'

import {
  isAddOnEnabled,
  loadTenantSettings,
  ORDER_SYSTEM_CONTEXT,
  type PayloadJobsRegistry,
} from '@mission-control/payload-jobs'
import {
  XeroInvoiceError,
  type XeroInvoiceAdapter,
  type XeroInvoiceDraft,
  type XeroInvoiceLineInput,
  type XeroInvoiceSettings,
  type XeroInvoiceSynced,
} from '@mission-control/payload-xero'

export const XERO_ADD_ON_KEY = 'xero'
/** `externalRefs[].provider` for the Xero invoice. */
export const XERO_EXTERNAL_REF_PROVIDER = 'xero'

/** Order statuses that get an invoice, and those whose invoice is authorised. */
export const INVOICED_ORDER_STATUSES = ['pending', 'invoiced', 'paid'] as const
export const CONFIRMED_ORDER_STATUSES = ['invoiced', 'paid'] as const

type ID = number | string
type Rec = Record<string, unknown>

const isRecord = (value: unknown): value is Rec => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const idOf = (value: unknown): ID | null =>
  isRecord(value) ? idOf(value.id) : typeof value === 'number' || typeof value === 'string' ? value : null
const text = (value: unknown): null | string => (typeof value === 'string' && value.trim() ? value.trim() : null)
const minor = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new XeroInvoiceError('invalid_invoice', 'The order’s amounts are not whole minor units.')
  }
  return value
}

/** What the mapping needs besides the order: looked up by the adapter, passed in by tests. */
export type OrderInvoiceContext = {
  contact: XeroInvoiceDraft['contact']
  /** Titles of the jobs the order pays for, shown on the plan line. */
  jobTitles: string[]
  /** The plan's name when the order has no quote snapshot. */
  planName: null | string
  reference: string
  settings: Pick<XeroInvoiceSettings, 'accountCodes'>
}

/** Whether this order should have a Xero invoice at all. */
export const orderNeedsInvoice = (order: Rec): boolean =>
  (INVOICED_ORDER_STATUSES as readonly string[]).includes(String(order.status)) &&
  order.paymentMethod === 'invoice' &&
  typeof order.total === 'number' &&
  order.total > 0 &&
  (order.legacyId === null || order.legacyId === undefined)

const describePlan = (name: string, jobTitles: string[]): string =>
  jobTitles.length > 0 ? `${name}: ${jobTitles.join(', ')}` : name

/**
 * The neutral invoice for an order. Pure: no I/O, so the money rules are unit-tested.
 * Returns `null` when the order needs no invoice.
 */
export const orderToXeroInvoice = (order: Rec, context: OrderInvoiceContext): null | XeroInvoiceDraft => {
  if (!orderNeedsInvoice(order)) return null

  const currency = text(order.currency)
  if (!currency) throw new XeroInvoiceError('invalid_invoice', 'The order has no currency.')

  const total = minor(order.total)
  const subtotal = minor(order.subtotal)
  const discount = minor(order.discount)
  const tax = minor(order.tax)
  const taxLines = Array.isArray(order.taxLines) ? order.taxLines.filter(isRecord) : []
  const taxed = tax > 0 || taxLines.some((line) => typeof line.tax === 'number' && line.tax > 0)
  const quote = isRecord(order.quote) ? order.quote : null
  const quoteLines = quote && Array.isArray(quote.lines) ? quote.lines.filter(isRecord) : null
  const codes = context.settings.accountCodes
  const lines: XeroInvoiceLineInput[] = []

  if (taxed) {
    // Each line carries its own tax, as the quote worked it out, so Xero's total is ours.
    if (!quoteLines) {
      throw new XeroInvoiceError('invalid_invoice', 'A taxed order needs its quote snapshot to be invoiced line by line.')
    }
    for (const line of quoteLines) {
      const amount = minor(line.amount)
      if (amount === 0) continue
      lines.push({
        accountCode: line.kind === 'plan' ? codes.plan : codes.addOn,
        description: line.kind === 'plan' ? describePlan(String(line.name ?? ''), context.jobTitles) : String(line.name ?? ''),
        discountAmount: minor(line.discount ?? 0),
        quantity: 1,
        taxAmount: minor(line.tax ?? 0),
        taxType: text(line.xeroTaxType),
        unitAmount: amount,
      })
    }

    return {
      confirmed: (CONFIRMED_ORDER_STATUSES as readonly string[]).includes(String(order.status)),
      contact: context.contact,
      currency,
      expectedTotal: total,
      lineAmountTypes: order.taxInclusive === true ? 'Inclusive' : 'Exclusive',
      lines,
      reference: context.reference,
    }
  }

  // No tax (vwok): full-price lines, then the discounts as their own lines on the discount
  // account, as the WordPress plugin did.
  if (quoteLines) {
    for (const line of quoteLines) {
      const amount = minor(line.amount)
      if (amount === 0) continue
      lines.push({
        accountCode: line.kind === 'plan' ? codes.plan : codes.addOn,
        description: line.kind === 'plan' ? describePlan(String(line.name ?? ''), context.jobTitles) : String(line.name ?? ''),
        quantity: 1,
        unitAmount: amount,
      })
    }
  } else {
    const addOns = Array.isArray(order.addOns) ? order.addOns.filter(isRecord) : []
    let addOnTotal = 0
    for (const addOn of addOns) {
      const amount = minor(addOn.amount)
      addOnTotal += amount
      if (amount === 0) continue
      lines.push({ accountCode: codes.addOn, description: String(addOn.name ?? 'Add-on'), quantity: 1, unitAmount: amount })
    }
    const planAmount = subtotal - addOnTotal
    if (planAmount < 0) throw new XeroInvoiceError('invalid_invoice', 'The order’s add-ons exceed its subtotal.')
    if (planAmount > 0) {
      lines.unshift({
        accountCode: codes.plan,
        description: describePlan(context.planName ?? 'Job listing', context.jobTitles),
        quantity: 1,
        unitAmount: planAmount,
      })
    }
  }

  const credits = quote && isRecord(quote.credits) && typeof quote.credits.discount === 'number' ? minor(quote.credits.discount) : 0
  const couponDiscount = discount - credits
  if (couponDiscount < 0) throw new XeroInvoiceError('invalid_invoice', 'The order’s credit discount exceeds its discount.')
  if (credits > 0) {
    lines.push({ accountCode: codes.discount, description: 'Job credit', quantity: 1, unitAmount: -credits })
  }
  if (couponDiscount > 0) {
    const code = text(order.couponCode)
    lines.push({
      accountCode: codes.discount,
      description: code ? `Coupon ${code}` : 'Discount',
      quantity: 1,
      unitAmount: -couponDiscount,
    })
  }

  return {
    confirmed: (CONFIRMED_ORDER_STATUSES as readonly string[]).includes(String(order.status)),
    contact: context.contact,
    currency,
    expectedTotal: total,
    lineAmountTypes: 'NoTax',
    lines,
    reference: context.reference,
  }
}

/** The order's external references with this invoice recorded (or its link updated). */
export const withXeroRef = (
  refs: unknown,
  invoice: Pick<XeroInvoiceSynced, 'invoiceId' | 'onlineUrl'>,
  provider = XERO_EXTERNAL_REF_PROVIDER,
): null | Rec[] => {
  const current = Array.isArray(refs) ? refs.filter(isRecord) : []
  const index = current.findIndex((ref) => ref.provider === provider && ref.externalId === invoice.invoiceId)
  const url = invoice.onlineUrl ?? null

  if (index === -1) return [...current, { externalId: invoice.invoiceId, provider, url }]
  // A link once recorded is kept: never replaced by nothing.
  if (url === null || current[index].url === url) return null

  return current.map((ref, at) => (at === index ? { ...ref, url } : ref))
}

export type OrderInvoiceAdapterOptions = {
  /** `externalRefs[].provider`. Defaults to `xero`. */
  provider?: string
  /** The invoice reference. Unique per order, stable across runs. Defaults to `Order {id}`. */
  reference?: (order: Rec) => string
  registry: PayloadJobsRegistry
}

/** Run `write` as system code, then put the request's context back as it was. */
const asSystem = async <T>(req: PayloadRequest | undefined, write: () => Promise<T>): Promise<T> => {
  if (!req) return write()

  const context = (req.context ??= {}) as Rec
  const had = Object.prototype.hasOwnProperty.call(context, ORDER_SYSTEM_CONTEXT)
  const before = context[ORDER_SYSTEM_CONTEXT]
  context[ORDER_SYSTEM_CONTEXT] = true
  try {
    return await write()
  } finally {
    if (had) context[ORDER_SYSTEM_CONTEXT] = before
    else delete context[ORDER_SYSTEM_CONTEXT]
  }
}

/** One document by id, as system code, or `null`. */
const load = async (payload: Payload, req: PayloadRequest | undefined, collection: string, id: ID | null): Promise<null | Rec> =>
  id === null
    ? null
    : ((await payload.findByID({
        collection: collection as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id,
        overrideAccess: true,
        req,
      })) as null | Rec)

/** payload-xero's adapter for the orders collection. */
export const orderInvoiceAdapter = ({
  provider = XERO_EXTERNAL_REF_PROVIDER,
  reference = (order) => `Order ${String(order.id)}`,
  registry,
}: OrderInvoiceAdapterOptions): XeroInvoiceAdapter => {
  const { slugs, tenancy } = registry.context

  return {
    sourceCollection: slugs.orders,
    tenantOf: (order) => (tenancy === 'multi' ? idOf(order.tenant) : null),

    toInvoice: async (order, { payload, req, settings }) => {
      if (!orderNeedsInvoice(order)) return null

      // The add-on switch is checked again here, because a queued retry outlives the event.
      const tenantID = tenancy === 'multi' ? idOf(order.tenant) : null
      const tenant = await loadTenantSettings(registry, payload, tenantID, req)
      if (!isAddOnEnabled(tenant, XERO_ADD_ON_KEY)) return null

      const organisation = await load(payload, req, slugs.organisations, idOf(order.organisation))
      if (!organisation) throw new XeroInvoiceError('invalid_invoice', 'The order’s organisation no longer exists.')
      if (tenancy === 'multi' && String(idOf(organisation.tenant)) !== String(tenantID)) {
        throw new XeroInvoiceError('invalid_invoice', 'The order’s organisation is in another tenant.')
      }

      const jobIDs = (Array.isArray(order.jobs) ? order.jobs : []).map(idOf).filter((id): id is ID => id !== null)
      const jobs =
        jobIDs.length === 0
          ? []
          : (
              await payload.find({
                collection: slugs.jobs as CollectionSlug,
                depth: 0,
                limit: jobIDs.length,
                overrideAccess: true,
                pagination: false,
                req,
                where: { and: [{ id: { in: jobIDs } }, { organisation: { equals: organisation.id } }] },
              })
            ).docs
      const plan = isRecord(order.quote) ? null : await load(payload, req, slugs.plans, idOf(order.plan))

      return orderToXeroInvoice(order, {
        contact: {
          code: text(organisation.xeroContactCode),
          email: text(organisation.billingEmail),
          legacyUserId: typeof organisation.legacyId === 'number' ? organisation.legacyId : null,
          name: text(organisation.name),
        },
        jobTitles: jobs.map((job) => text((job as unknown as Rec).title)).filter((title): title is string => title !== null),
        planName: plan ? text(plan.name) : null,
        reference: reference(order),
        settings,
      })
    },

    onSynced: async ({ doc, invoice, payload, req }) => {
      // Re-read: the document the sync loaded may predate a ref another run just added.
      const order = (await load(payload, req, slugs.orders, idOf(doc.id))) ?? doc
      const externalRefs = withXeroRef(order.externalRefs, invoice, provider)
      if (!externalRefs) return

      // The orders collection appends each new or changed reference to the order's log.
      await asSystem(req, () =>
        payload.update({
          collection: slugs.orders as CollectionSlug,
          data: { externalRefs } as never,
          depth: 0,
          id: idOf(doc.id) as ID,
          overrideAccess: true,
          req,
        }),
      )
    },
  }
}
