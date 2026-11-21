/**
 * Xero sales invoices (PJ-57): the HTTP calls and the money conversion behind the invoice sync.
 *
 * Money comes in as whole minor units of one currency and goes to Xero as decimals with the
 * currency's own number of decimal places, so no floating-point arithmetic ever touches an
 * amount. Totals coming back from Xero are turned into minor units again and compared exactly.
 *
 * Every write carries an `Idempotency-Key`, so a request whose answer was lost (a timeout, a
 * dropped connection) can be sent again without Xero creating a second invoice.
 *
 * `fetch` only, with Xero's `xero-tenant-id` header, so this runs on Cloudflare Workers. Errors
 * never carry a token.
 */
import { XERO_API_BASE_URL, XERO_API_TIMEOUT_MS, type XeroApiArgs } from './contacts'

export type XeroInvoiceErrorCode =
  /** The source document cannot become an invoice (bad lines, unknown currency...). */
  | 'invalid_invoice'
  /** Xero has a voided or deleted invoice for this document. A person decides what happens. */
  | 'invoice_voided'
  /** Xero holds no access token or organisation for this tenant. */
  | 'not_connected'
  /** An invoice with this reference exists in Xero but is not this document's. */
  | 'reference_conflict'
  /** Another run holds this document's sync lease. */
  | 'sync_in_progress'
  /** Xero's invoice total differs from the document's, so it is not authorised. */
  | 'total_mismatch'
  /** Xero refused the request (validation, permissions). Retrying the same request will not help. */
  | 'xero_rejected'
  /** Xero could not be reached, timed out, rate limited or failed. Worth retrying. */
  | 'xero_unavailable'

/** Codes a later attempt can fix on its own. Everything else needs a person. */
export const RETRYABLE_INVOICE_ERRORS: readonly XeroInvoiceErrorCode[] = ['sync_in_progress', 'xero_unavailable']

/** An invoice failure with a stable `code`. Never holds a token. */
export class XeroInvoiceError extends Error {
  readonly code: XeroInvoiceErrorCode
  readonly details?: Record<string, unknown>
  readonly retryable: boolean

  constructor(
    code: XeroInvoiceErrorCode,
    message: string,
    details?: Record<string, unknown>,
    retryable: boolean = RETRYABLE_INVOICE_ERRORS.includes(code),
  ) {
    super(message)
    this.name = 'XeroInvoiceError'
    this.code = code
    this.details = details
    this.retryable = retryable
  }
}

// ---------------------------------------------------------------------------------------------
// Money

const CURRENCY = /^[A-Z]{3}$/

/**
 * Decimal places of an ISO 4217 currency (VUV 0, NZD 2, KWD 3), from the runtime's ICU data.
 * Throws `invalid_invoice` for a code that is not a currency.
 */
export const currencyExponent = (currency: string): number => {
  if (!CURRENCY.test(currency)) {
    throw new XeroInvoiceError('invalid_invoice', `"${currency}" is not an ISO 4217 currency code.`)
  }

  try {
    const digits = new Intl.NumberFormat('en', { currency, style: 'currency' }).resolvedOptions()
      .maximumFractionDigits

    if (typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 4) return digits
  } catch {
    // Fall through: an unknown currency.
  }

  throw new XeroInvoiceError('invalid_invoice', `"${currency}" is not a currency this runtime knows.`)
}

/**
 * Minor units to the decimal Xero expects, built from the digits so no float rounding happens:
 * `minorToDecimal(1999, 2)` is `19.99`, `minorToDecimal(3900, 0)` is `3900`.
 */
export const minorToDecimal = (minor: number, exponent: number): number => {
  if (!Number.isSafeInteger(minor)) {
    throw new XeroInvoiceError('invalid_invoice', 'Amounts must be whole minor units.')
  }
  if (exponent === 0) return minor

  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0')
  const text = `${minor < 0 ? '-' : ''}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`

  return Number(text)
}

/**
 * A decimal from Xero back to minor units. Xero rounds to the currency's places, so the value
 * times the scale is within float noise of a whole number; anything further off is refused.
 */
export const decimalToMinor = (value: unknown, exponent: number): null | number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null

  const scaled = value * 10 ** exponent
  const rounded = Math.round(scaled)

  return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) < 1e-6 ? rounded : null
}

// ---------------------------------------------------------------------------------------------
// Invoice input

/** How Xero reads the line amounts. */
export type XeroLineAmountTypes = 'Exclusive' | 'Inclusive' | 'NoTax'

export type XeroInvoiceLineInput = {
  /** Sales account code. */
  accountCode?: null | string
  description: string
  /** Minor units taken off this line (credits, coupons). */
  discountAmount?: number
  /** Whole units. */
  quantity: number
  /** Minor units the caller already worked out for this line; Xero then uses it as is. */
  taxAmount?: number
  /** Xero tax type, e.g. `OUTPUT`. Left out: the account's default. */
  taxType?: null | string
  /** Minor units per unit. Negative for a discount line. */
  unitAmount: number
}

/** A neutral invoice: what the adapter makes of one source document. */
export type XeroInvoiceInput = {
  contact: {
    /** The payer's stored Xero contact code. */
    code?: null | string
    email?: null | string
    /** Legacy WordPress user id, matched as `AXI-{id}` (PJ-56). */
    legacyUserId?: null | number
    name?: null | string
  }
  /** ISO 4217. */
  currency: string
  /**
   * What the invoice must total, in minor units. Xero's total is checked against it, and an
   * invoice that differs is never authorised.
   */
  expectedTotal: number
  lineAmountTypes: XeroLineAmountTypes
  lines: XeroInvoiceLineInput[]
  /**
   * Unique per source document and stable across runs: a lost response is recovered by finding
   * the invoice with this reference.
   */
  reference: string
}

const REFERENCE_MAX = 255
const DESCRIPTION_MAX = 4000

const isMinor = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/** Everything wrong with an invoice input, as messages. Empty when it can be sent. */
export const invoiceInputProblems = (input: XeroInvoiceInput): string[] => {
  const problems: string[] = []

  if (!CURRENCY.test(input.currency ?? '')) problems.push('currency must be an ISO 4217 code')
  if (!input.reference?.trim()) problems.push('reference is required')
  else if (input.reference.length > REFERENCE_MAX) problems.push(`reference is longer than ${REFERENCE_MAX}`)
  else if (/["\\]/.test(input.reference)) problems.push('reference cannot contain a quote or backslash')
  if (!['Exclusive', 'Inclusive', 'NoTax'].includes(input.lineAmountTypes)) problems.push('lineAmountTypes is invalid')
  if (!isMinor(input.expectedTotal) || input.expectedTotal <= 0) problems.push('expectedTotal must be above 0')
  if (!Array.isArray(input.lines) || input.lines.length === 0) problems.push('an invoice needs at least one line')

  for (const [index, line] of (input.lines ?? []).entries()) {
    const at = `line ${index + 1}`
    if (!line.description?.trim()) problems.push(`${at}: description is required`)
    else if (line.description.length > DESCRIPTION_MAX) problems.push(`${at}: description is too long`)
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) problems.push(`${at}: quantity must be a whole number above 0`)
    if (!isMinor(line.unitAmount)) problems.push(`${at}: unitAmount must be whole minor units`)
    if (line.discountAmount !== undefined && (!isMinor(line.discountAmount) || line.discountAmount < 0)) {
      problems.push(`${at}: discountAmount must be whole minor units, 0 or more`)
    }
    if (line.taxAmount !== undefined && (!isMinor(line.taxAmount) || line.taxAmount < 0)) {
      problems.push(`${at}: taxAmount must be whole minor units, 0 or more`)
    }
  }

  // Without tax, the lines must add up to the expected total; with tax, Xero's total is checked
  // after the invoice is created instead.
  if (problems.length === 0 && input.lineAmountTypes !== 'Exclusive') {
    let sum = 0
    for (const line of input.lines) sum += line.quantity * line.unitAmount - (line.discountAmount ?? 0)
    if (!Number.isSafeInteger(sum) || sum !== input.expectedTotal) {
      problems.push(`the lines add up to ${sum}, not the expected total ${input.expectedTotal}`)
    }
  }

  return problems
}

/** Settings the plugin adds to every invoice. */
export type XeroInvoiceDefaults = {
  brandingThemeId?: null | string
  tracking?: null | { name?: null | string; option?: null | string }
}

/** The Xero `Invoices` element for a new draft. */
export const buildDraftInvoice = (
  input: XeroInvoiceInput,
  contactId: string,
  defaults: XeroInvoiceDefaults = {},
): Record<string, unknown> => {
  const problems = invoiceInputProblems(input)
  if (problems.length > 0) {
    throw new XeroInvoiceError('invalid_invoice', `The invoice cannot be sent: ${problems.join('; ')}.`)
  }

  const exponent = currencyExponent(input.currency)
  const trackingName = defaults.tracking?.name?.trim()
  const trackingOption = defaults.tracking?.option?.trim()
  const tracking = trackingName && trackingOption ? [{ Name: trackingName, Option: trackingOption }] : undefined

  return {
    ...(defaults.brandingThemeId?.trim() ? { BrandingThemeID: defaults.brandingThemeId.trim() } : {}),
    Contact: { ContactID: contactId },
    CurrencyCode: input.currency,
    LineAmountTypes: input.lineAmountTypes,
    LineItems: input.lines.map((line) => ({
      ...(line.accountCode?.trim() ? { AccountCode: line.accountCode.trim() } : {}),
      Description: line.description.trim(),
      ...(line.discountAmount ? { DiscountAmount: minorToDecimal(line.discountAmount, exponent) } : {}),
      Quantity: line.quantity,
      ...(line.taxAmount !== undefined && input.lineAmountTypes !== 'NoTax'
        ? { TaxAmount: minorToDecimal(line.taxAmount, exponent) }
        : {}),
      ...(line.taxType?.trim() && input.lineAmountTypes !== 'NoTax' ? { TaxType: line.taxType.trim() } : {}),
      ...(tracking ? { Tracking: tracking } : {}),
      UnitAmount: minorToDecimal(line.unitAmount, exponent),
    })),
    Reference: input.reference,
    Status: 'DRAFT',
    Type: 'ACCREC',
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP

/** The part of a Xero invoice the sync reads. */
export type XeroInvoiceRecord = {
  Contact?: null | { ContactID?: null | string }
  CurrencyCode?: null | string
  /** .NET date or ISO, as Xero sends it. */
  Date?: null | string
  DateString?: null | string
  InvoiceID: string
  InvoiceNumber?: null | string
  Reference?: null | string
  Status?: null | string
  Total?: null | number
  Type?: null | string
}

const isInvoice = (value: unknown): value is XeroInvoiceRecord =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { InvoiceID?: unknown }).InvoiceID === 'string' &&
  Boolean((value as { InvoiceID: string }).InvoiceID)

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Xero's own message, which says what it disliked about a request. Never echoes headers. */
const xeroMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined

  const record = body as Record<string, unknown>
  const messages: string[] = []

  if (Array.isArray(record.Elements)) {
    for (const element of record.Elements) {
      const errors = (element as { ValidationErrors?: unknown } | null)?.ValidationErrors
      if (!Array.isArray(errors)) continue
      for (const error of errors) {
        const message = (error as { Message?: unknown } | null)?.Message
        if (typeof message === 'string' && message) messages.push(message)
      }
    }
  }
  if (messages.length === 0 && typeof record.Message === 'string' && record.Message) messages.push(record.Message)
  if (messages.length === 0 && typeof record.Detail === 'string' && record.Detail) messages.push(record.Detail)

  return messages.length > 0 ? messages.join('; ').slice(0, 300) : undefined
}

type InvoiceRequest = XeroApiArgs & {
  body?: unknown
  idempotencyKey?: string
  method: 'GET' | 'POST' | 'PUT'
  path: string
}

/**
 * One authenticated call. Transport failures, timeouts, 401, 429 and 5xx are
 * `xero_unavailable` (retryable: a later run gets a fresh token or a calmer Xero); any other
 * error status is `xero_rejected`.
 */
const request = async ({
  accessToken,
  apiBaseUrl = XERO_API_BASE_URL,
  body,
  fetch = globalThis.fetch,
  idempotencyKey,
  method,
  path,
  tenantId,
  timeoutMs = XERO_API_TIMEOUT_MS,
}: InvoiceRequest): Promise<unknown> => {
  if (!accessToken?.trim() || !tenantId?.trim()) {
    throw new XeroInvoiceError('not_connected', 'Connect Xero for this tenant before invoicing.')
  }

  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        'xero-tenant-id': tenantId,
      },
      method,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'

    throw new XeroInvoiceError('xero_unavailable', timedOut ? 'Xero did not answer in time.' : 'Could not reach Xero.', {
      cause: error instanceof Error ? error.name : 'network_error',
    })
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const message = xeroMessage(payload)
    const transient = response.status === 401 || response.status === 429 || response.status >= 500

    throw new XeroInvoiceError(
      transient ? 'xero_unavailable' : 'xero_rejected',
      message ? `Xero refused the invoice request: ${message}` : `Xero refused the invoice request (HTTP ${response.status}).`,
      { ...(message ? { message } : {}), status: response.status },
    )
  }

  return payload
}

const invoicesFrom = (body: unknown): XeroInvoiceRecord[] => {
  const invoices = (body as { Invoices?: unknown } | null | undefined)?.Invoices

  if (!Array.isArray(invoices)) {
    throw new XeroInvoiceError('xero_unavailable', 'Xero returned an unreadable invoices response.')
  }

  return invoices.filter(isInvoice)
}

/** Invoices with this exact reference that are not voided or deleted. */
export const findInvoicesByReference = async (
  api: XeroApiArgs,
  reference: string,
): Promise<XeroInvoiceRecord[]> => {
  if (/["\\]/.test(reference)) {
    throw new XeroInvoiceError('invalid_invoice', 'An invoice reference cannot contain a quote or backslash.')
  }

  const query = new URLSearchParams({
    Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
    where: `Type=="ACCREC" AND Reference=="${reference}"`,
  })
  const invoices = invoicesFrom(await request({ ...api, method: 'GET', path: `/Invoices?${query.toString()}` }))

  // Xero's `==` is case-insensitive; the reference must match exactly.
  return invoices.filter((invoice) => invoice.Reference === reference)
}

export const getInvoice = async (api: XeroApiArgs, invoiceId: string): Promise<XeroInvoiceRecord | null> => {
  if (!GUID.test(invoiceId)) throw new XeroInvoiceError('invalid_invoice', 'The stored Xero invoice id is not valid.')

  try {
    const [invoice] = invoicesFrom(await request({ ...api, method: 'GET', path: `/Invoices/${invoiceId}` }))
    return invoice ?? null
  } catch (error) {
    if (error instanceof XeroInvoiceError && error.details?.status === 404) return null
    throw error
  }
}

const single = (body: unknown, what: string): XeroInvoiceRecord => {
  const [invoice] = invoicesFrom(body)
  if (!invoice) throw new XeroInvoiceError('xero_unavailable', `Xero accepted the ${what} but returned no invoice.`)

  return invoice
}

/** Create one draft. `idempotencyKey` makes a resend of the same request return the same invoice. */
export const createDraftInvoice = async (
  api: XeroApiArgs,
  invoice: Record<string, unknown>,
  idempotencyKey: string,
): Promise<XeroInvoiceRecord> =>
  single(
    await request({ ...api, body: { Invoices: [invoice] }, idempotencyKey, method: 'PUT', path: '/Invoices' }),
    'invoice',
  )

/** Move a draft to AUTHORISED with its due date (`YYYY-MM-DD`). */
export const authoriseInvoice = async (
  api: XeroApiArgs,
  { dueDate, invoiceId }: { dueDate: string; invoiceId: string },
  idempotencyKey: string,
): Promise<XeroInvoiceRecord> => {
  if (!GUID.test(invoiceId)) throw new XeroInvoiceError('invalid_invoice', 'The stored Xero invoice id is not valid.')

  return single(
    await request({
      ...api,
      body: { Invoices: [{ DueDate: dueDate, InvoiceID: invoiceId, Status: 'AUTHORISED' }] },
      idempotencyKey,
      method: 'POST',
      path: `/Invoices/${invoiceId}`,
    }),
    'authorisation',
  )
}

/** The customer-facing online invoice link. Xero only has one for an approved invoice. */
export const getOnlineInvoiceUrl = async (api: XeroApiArgs, invoiceId: string): Promise<null | string> => {
  if (!GUID.test(invoiceId)) throw new XeroInvoiceError('invalid_invoice', 'The stored Xero invoice id is not valid.')

  const body = await request({ ...api, method: 'GET', path: `/Invoices/${invoiceId}/OnlineInvoice` })
  const online = (body as { OnlineInvoices?: { OnlineInvoiceUrl?: unknown }[] } | null)?.OnlineInvoices?.[0]
  const url = typeof online?.OnlineInvoiceUrl === 'string' ? online.OnlineInvoiceUrl : null

  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Dates

/** `YYYY-MM-DD` of a Xero date (`/Date(ms+0000)/`, or an ISO string), as Xero meant it. */
export const xeroDay = (invoice: Pick<XeroInvoiceRecord, 'Date' | 'DateString'>): null | string => {
  const iso = invoice.DateString ?? null
  if (iso && /^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10)

  const dotNet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(invoice.Date ?? '')
  if (dotNet) return new Date(Number(dotNet[1])).toISOString().slice(0, 10)
  if (invoice.Date && /^\d{4}-\d{2}-\d{2}/.test(invoice.Date)) return invoice.Date.slice(0, 10)

  return null
}

/** `day` plus `days`, as `YYYY-MM-DD`. Calendar arithmetic in UTC, so no timezone shifts it. */
export const addDays = (day: string, days: number): string => {
  const date = new Date(`${day}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || !Number.isInteger(days)) {
    throw new XeroInvoiceError('invalid_invoice', 'Cannot work out the invoice due date.')
  }
  date.setUTCDate(date.getUTCDate() + days)

  return date.toISOString().slice(0, 10)
}

/** A SHA-256 hex digest, for idempotency keys that change when the request does. */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
