/**
 * The invoice link for an order (PJ-58): Xero's online invoice when it has one, otherwise an
 * HTML invoice rendered from the order itself.
 *
 * Who may open it: whoever may read the order. The order is loaded through Payload's own access
 * with the caller's user (`overrideAccess: false`), so the order's organisation members and the
 * tenant's site managers get it, and another organisation or another tenant gets `not_found`
 * rather than a hint that the order exists.
 *
 * Why a fallback: a Xero invoice only has an online link once it is submitted or authorised, and
 * a tenant may never have connected Xero at all. An employer still needs something to download
 * and pay from, so the order's money (one shared mapping, `orderInvoiceSummary`) is printed as a
 * self-contained, script-free HTML page by payload-xero's renderer.
 */
import type { CollectionSlug, Endpoint, Payload, PayloadRequest } from 'payload'

import { isAddOnEnabled, loadTenantSettings, type MissionControlUser, type PayloadJobsRegistry } from '@mission-control/payload-jobs'
import {
  addDays,
  findInvoiceSettings,
  invoiceFileName,
  renderInvoiceHTML,
  XeroInvoiceError,
  type InvoiceHTMLDocument,
  type InvoiceParty,
} from '@mission-control/payload-xero'

import { orderInvoiceSummary, XERO_ADD_ON_KEY, type OrderInvoiceLinesContext } from './order-invoice'

export const INVOICE_LINK_ERROR_CODES = ['no_invoice', 'not_found', 'not_signed_in'] as const
export type InvoiceLinkErrorCode = (typeof INVOICE_LINK_ERROR_CODES)[number]

const STATUS_FOR: Record<InvoiceLinkErrorCode, number> = {
  no_invoice: 404,
  not_found: 404,
  not_signed_in: 401,
}

/** A refusal the endpoint turns into JSON, and the admin action into nothing. */
export class InvoiceLinkError extends Error {
  readonly code: InvoiceLinkErrorCode
  readonly status: number

  constructor(code: InvoiceLinkErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'InvoiceLinkError'
    this.status = STATUS_FOR[code]
  }
}

type ID = number | string
type Rec = Record<string, unknown>

const isRecord = (value: unknown): value is Rec => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const idOf = (value: unknown): ID | null =>
  isRecord(value) ? idOf(value.id) : typeof value === 'number' || typeof value === 'string' ? value : null
const text = (value: unknown): null | string => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** An order's invoice, as the endpoint hands it out. */
export type OrderInvoiceLink =
  | { kind: 'xero'; reference: string; url: string }
  | { currency: string; filename: string; html: string; kind: 'html'; reference: string; total: number }

/** The tenant fields the HTML reads: its locale, name and tax label. */
export type InvoiceTenant = {
  defaultLocale?: null | string
  name?: null | string
  taxLabel?: null | string
  /** Read by the add-on switch: which add-ons this tenant has on. */
  addOns?: unknown
}

export type InvoiceHTMLForOrderArgs = {
  /** The number of days until payment is due, from the tenant's Xero settings. */
  dueDays?: null | number
  /** The invoice number Xero gave it, when there is one. */
  invoiceNumber?: null | string
  /** The issuer printed at the top. Defaults to the tenant's name. */
  issuer?: (tenant: InvoiceTenant) => InvoiceParty
  /** Titles of the jobs the order pays for. */
  jobTitles: string[]
  order: Rec
  organisation: null | Rec
  planName: null | string
  reference: string
  tenant: InvoiceTenant
}

const DEFAULT_LOCALE = 'en'

/** The default issuer: the tenant's own name. A site can pass its own with `issuer`. */
export const tenantIssuer = (tenant: InvoiceTenant): InvoiceParty => ({ name: text(tenant.name) })

/**
 * The HTML invoice for an order, or `null` when it needs none (free, paid by credit, a legacy
 * import, not invoiced yet). Pure: the money comes from the shared order mapping, so the page and
 * the Xero invoice can never disagree.
 */
export const invoiceHTMLForOrder = ({
  dueDays = null,
  invoiceNumber,
  issuer = tenantIssuer,
  jobTitles,
  order,
  organisation,
  planName,
  reference,
  tenant,
}: InvoiceHTMLForOrderArgs): null | { currency: string; filename: string; html: string; reference: string; total: number } => {
  const lines: OrderInvoiceLinesContext = { jobTitles, planName }
  const summary = orderInvoiceSummary(order, lines)
  if (!summary) return null

  const invoiceDate = text(order.createdAt)?.slice(0, 10) ?? null
  const charged = summary.lines.reduce(
    (sum, line) => sum + line.quantity * line.unitAmount - (line.discountAmount ?? 0),
    0,
  )
  const taxed = summary.lineAmountTypes !== 'NoTax'
  const taxLabel = text(tenant.taxLabel)
  const invoiceNumberText = text(invoiceNumber)

  const document: InvoiceHTMLDocument = {
    currency: summary.currency,
    ...(invoiceDate && typeof dueDays === 'number' ? { dueDate: addDays(invoiceDate, dueDays) } : {}),
    ...(invoiceDate ? { invoiceDate } : {}),
    ...(invoiceNumberText ? { invoiceNumber: invoiceNumberText } : {}),
    issuer: issuer(tenant),
    lines: summary.lines.map((line) => ({
      ...(line.discountAmount === undefined ? {} : { discountAmount: line.discountAmount }),
      description: line.description,
      quantity: line.quantity,
      ...(line.taxAmount === undefined ? {} : { taxAmount: line.taxAmount }),
      unitAmount: line.unitAmount,
    })),
    ...(organisation
      ? { payer: { email: text(organisation.billingEmail), name: text(organisation.name) } }
      : {}),
    reference,
    ...(taxLabel ? { taxLabel } : {}),
    // With tax, the tax is a row of its own before the total: the sum of the lines excludes it.
    ...(taxed ? { taxTotal: summary.total - charged } : {}),
    total: summary.total,
  }

  return {
    currency: summary.currency,
    filename: invoiceFileName(reference),
    html: renderInvoiceHTML(document, { locale: text(tenant.defaultLocale) ?? DEFAULT_LOCALE }),
    reference,
    total: summary.total,
  }
}

/**
 * The invoicing config the admin component needs, read back from the built config. `null` when
 * the host built payload-xero without invoicing, so there are no invoice records to read.
 */
export const readOrderInvoiceConfig = (
  config: { custom?: unknown },
): null | { invoicesSlug: string; scope: 'global' | 'tenant'; settingsSlug: string; tenantField: string } => {
  const custom = (config.custom as undefined | { payloadXero?: { invoicesSlug?: null | string; scope: 'global' | 'tenant'; settingsSlug: string; tenantField?: string } })?.payloadXero
  if (!custom?.invoicesSlug) return null

  return {
    invoicesSlug: custom.invoicesSlug,
    scope: custom.scope,
    settingsSlug: custom.settingsSlug,
    tenantField: custom.tenantField ?? 'tenant',
  }
}

const invoiceRowFor = async (
  payload: Payload,
  invoicesSlug: string,
  ordersSlug: string,
  orderID: ID,
): Promise<null | Rec> => {
  const { docs } = await payload.find({
    collection: invoicesSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    showHiddenFields: true,
    where: { and: [{ source: { equals: ordersSlug } }, { sourceId: { equals: String(orderID) } }] },
  })

  return (docs[0] as unknown as Rec | undefined) ?? null
}

export type OrderInvoiceLinkArgs = {
  /** The invoicing config's slugs and scope, for the settings row. */
  config: { invoicesSlug: string; scope: 'global' | 'tenant'; settingsSlug: string; tenantField: string }
  issuer?: (tenant: InvoiceTenant) => InvoiceParty
  orderID: ID
  payload: Payload
  reference?: (order: Rec) => string
  registry: PayloadJobsRegistry
  req?: PayloadRequest
  /** The caller. Omitted: `req.user`. */
  user?: MissionControlUser | null
}

/**
 * Resolve one order's invoice for `user`, under Payload's order access. Throws `not_found` when
 * the order is missing or not theirs, `no_invoice` when it has none or the tenant has the Xero
 * add-on off, `not_signed_in` with no user.
 */
export const resolveOrderInvoiceLink = async ({
  config,
  issuer = tenantIssuer,
  orderID,
  payload,
  reference = (order) => `Order ${String(order.id)}`,
  registry,
  req,
  user: passedUser,
}: OrderInvoiceLinkArgs): Promise<OrderInvoiceLink> => {
  const user = passedUser === undefined ? ((req?.user as MissionControlUser | null) ?? null) : passedUser
  if (!user) throw new InvoiceLinkError('not_signed_in', 'Sign in to open this invoice.')

  const { slugs, tenancy } = registry.context
  const order = (await payload.findByID({
    collection: slugs.orders as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: orderID,
    overrideAccess: false,
    req,
    user: user as never,
  })) as null | Rec
  if (!order) throw new InvoiceLinkError('not_found', 'No such order.')

  const tenantID = tenancy === 'multi' ? idOf(order.tenant) : null
  const tenant = (await loadTenantSettings(registry, payload, tenantID, req)) as unknown as InvoiceTenant | null
  // The invoice belongs to the invoicing add-on: a tenant that switches Xero off has none.
  if (!isAddOnEnabled(tenant, XERO_ADD_ON_KEY)) throw new InvoiceLinkError('no_invoice', 'This site does not invoice orders.')

  const invoiceReference = reference(order)
  const row = await invoiceRowFor(payload, config.invoicesSlug, slugs.orders, orderID)
  const onlineUrl = text(row?.onlineUrl)
  if (onlineUrl) return { kind: 'xero', reference: invoiceReference, url: onlineUrl }

  const jobIDs = (Array.isArray(order.jobs) ? order.jobs : []).map(idOf).filter((id): id is ID => id !== null)
  const [organisation, jobs, plan, settings] = await Promise.all([
    order.organisation
      ? (payload.findByID({
          collection: slugs.organisations as CollectionSlug,
          depth: 0,
          disableErrors: true,
          id: idOf(order.organisation) as ID,
          overrideAccess: true,
          req,
        }) as Promise<null | Rec>)
      : Promise.resolve(null),
    jobIDs.length === 0
      ? Promise.resolve([] as Rec[])
      : payload
          .find({
            collection: slugs.jobs as CollectionSlug,
            depth: 0,
            limit: jobIDs.length,
            overrideAccess: true,
            pagination: false,
            req,
            where: { id: { in: jobIDs } },
          })
          .then((result) => result.docs as unknown as Rec[]),
    isRecord(order.quote) || !order.plan
      ? Promise.resolve(null)
      : (payload.findByID({
          collection: slugs.plans as CollectionSlug,
          depth: 0,
          disableErrors: true,
          id: idOf(order.plan) as ID,
          overrideAccess: true,
          req,
        }) as Promise<null | Rec>),
    findInvoiceSettings(
      { ...config, scope: tenancy === 'multi' ? 'tenant' : 'global' },
      payload,
      tenantID,
    ).catch(() => null),
  ])

  const fallback = invoiceHTMLForOrder({
    dueDays: typeof settings?.dueDays === 'number' ? settings.dueDays : null,
    invoiceNumber: text(row?.invoiceNumber),
    issuer,
    jobTitles: jobs.map((job) => text(job.title)).filter((title): title is string => title !== null),
    order,
    organisation,
    planName: text(plan?.name),
    reference: invoiceReference,
    tenant: tenant ?? {},
  })
  if (!fallback) throw new InvoiceLinkError('no_invoice', 'This order has no invoice.')

  return { kind: 'html', ...fallback }
}

const errorResponse = (error: InvoiceLinkError): Response =>
  Response.json(
    { error: { code: error.code, message: error.message } },
    { headers: { 'cache-control': 'no-store' }, status: error.status },
  )

const htmlHeaders = (filename: string, download: boolean): Record<string, string> => ({
  'cache-control': 'no-store',
  'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
  // The page carries its own styles and needs nothing else: no scripts, images or fonts.
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
})

export type OrderInvoiceEndpointOptions = Omit<OrderInvoiceLinkArgs, 'orderID' | 'payload' | 'req' | 'user'>

/**
 * The order's invoice over HTTP, on the orders collection:
 *
 * - `GET /api/orders/:id/invoice`: Xero's own page (302) when the invoice has an online link,
 *   otherwise the HTML invoice itself.
 * - `?format=json`: the link itself, which the admin action and the tests read.
 * - `?download=1`: the HTML as an attachment rather than something to view in place.
 *
 * The caller's user goes straight into the order lookup, so the endpoint grants nothing the
 * orders collection would not: another organisation's or another tenant's order is `not_found`.
 */
export const orderInvoiceEndpoints = (options: OrderInvoiceEndpointOptions): Endpoint[] => [
  {
    handler: async (req) => {
      try {
        const orderID = req.routeParams?.id
        if (typeof orderID !== 'string' || !orderID) throw new InvoiceLinkError('not_found', 'No such order.')

        const link = await resolveOrderInvoiceLink({ ...options, orderID, payload: req.payload, req })
        const { download, format } = req.query ?? {}

        if (format === 'json') {
          return Response.json(
            link.kind === 'xero'
              ? { kind: link.kind, reference: link.reference, url: link.url }
              : {
                  currency: link.currency,
                  filename: link.filename,
                  kind: link.kind,
                  reference: link.reference,
                  total: link.total,
                },
            { headers: { 'cache-control': 'no-store' } },
          )
        }

        if (link.kind === 'xero') {
          return new Response(null, {
            headers: { 'cache-control': 'no-store', location: link.url, 'referrer-policy': 'no-referrer' },
            status: 302,
          })
        }

        return new Response(link.html, { headers: htmlHeaders(link.filename, download === '1' || download === true) })
      } catch (error) {
        if (error instanceof InvoiceLinkError) return errorResponse(error)
        if (error instanceof XeroInvoiceError) return errorResponse(new InvoiceLinkError('no_invoice', error.message))

        req.payload.logger.error({ err: error, msg: 'invoice link: could not build the order invoice' })
        return Response.json(
          { error: { code: 'server_error', message: 'Something went wrong.' } },
          { headers: { 'cache-control': 'no-store' }, status: 500 },
        )
      }
    },
    method: 'get',
    path: '/:id/invoice',
  },
]
