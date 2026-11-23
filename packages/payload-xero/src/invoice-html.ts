/**
 * The HTML invoice fallback (PJ-58): a printable invoice built from a neutral document, for
 * orders whose Xero invoice has no online link (a draft, or a tenant that never connected Xero).
 *
 * The document carries money in whole minor units, like everything else in the job board, and is
 * turned into text here with the currency's own number of decimal places, so no float arithmetic
 * touches an amount. Every value that reaches the page is escaped: a job title or an organisation
 * name is user input and must never become markup.
 *
 * Self-contained on purpose: no stylesheet, font or script is fetched, so it renders the same in
 * the admin, in an email client and on a Worker, and the page can be printed as it stands.
 */
import { currencyExponent } from './invoices'

export type InvoiceParty = {
  /** Street address lines, printed as given. */
  addressLines?: string[]
  email?: null | string
  name?: null | string
  /** Tax or company registration number, when the tenant has one. */
  taxId?: null | string
}

export type InvoiceHTMLDocument = {
  /** ISO 4217. Every amount below is a whole number of this currency's minor units. */
  currency: string
  dueDate?: null | string
  invoiceDate?: null | string
  invoiceNumber?: null | string
  issuer?: InvoiceParty
  lines: InvoiceHTMLLine[]
  notes?: null | string
  payer?: InvoiceParty
  /** Unique per source document: the order reference the invoice was raised for. */
  reference: string
  /** The tenant's name for its tax, e.g. `VAT`. Omitted: the invoice has no tax. */
  taxLabel?: null | string
  /** Minor units of tax on the whole invoice, shown as its own row when not 0. */
  taxTotal?: number
  title?: string
  total: number
}

export type InvoiceHTMLLine = {
  description: string
  /** Minor units taken off this line; negative `unitAmount`s are discounts and keep their sign. */
  discountAmount?: number
  quantity: number
  /** Minor units of tax on this line, when the document gives it. */
  taxAmount?: number
  /** Minor units per unit. */
  unitAmount: number
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escape text for HTML text nodes and attribute values. */
export const escapeHTML = (value: string): string => value.replace(/[&<>"']/g, (character) => ESCAPES[character]!)

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const digitsOf = (minor: number, exponent: number): string => {
  if (!Number.isSafeInteger(minor)) throw new Error('Invoice amounts must be whole minor units')

  const digits = String(Math.abs(minor)).padStart(exponent + 1, '0')
  const whole = digits.slice(0, digits.length - exponent) || '0'
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : ''

  return `${minor < 0 ? '-' : ''}${whole}${fraction}`
}

const formatters = new Map<string, Intl.NumberFormat>()

const moneyFormatter = (currency: string, locale: string, exponent: number): Intl.NumberFormat => {
  const key = `${locale}:${currency}:${exponent}`
  const cached = formatters.get(key)
  if (cached) return cached

  const formatter = new Intl.NumberFormat(locale, {
    currency: currency.toUpperCase(),
    currencyDisplay: 'narrowSymbol',
    maximumFractionDigits: exponent,
    minimumFractionDigits: exponent,
    style: 'currency',
  })
  formatters.set(key, formatter)

  return formatter
}

/**
 * Money for an invoice: the tenant's currency and locale, from whole minor units. `3900` VUV is
 * `Vt 3,900`, `1999` NZD is `$19.99`.
 */
export const invoiceMoney = (minor: number, currency: string, locale = 'en'): string => {
  const exponent = currencyExponent(currency)
  const decimal = Number(digitsOf(minor, exponent))

  return moneyFormatter(currency, locale, exponent).format(decimal)
}

/** `YYYY-MM-DD` for a date the document gives as an ISO string, or `null`. */
const day = (value: null | string | undefined): null | string => {
  if (!value) return null
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value)

  return match ? match[1]! : null
}

const party = (who: InvoiceParty | undefined, heading: string): string => {
  if (!who) return ''
  const rows = [who.name, ...(who.addressLines ?? []), who.taxId, who.email]
    .map(text)
    .filter((row) => row.trim())
    .map((row) => `<div>${escapeHTML(row)}</div>`)
    .join('')

  return rows ? `<section class="party"><h2>${escapeHTML(heading)}</h2>${rows}</section>` : ''
}

/**
 * The invoice as a complete HTML document. `locale` sets the number formatting and the page
 * language; it is the tenant's, never the browser's.
 */
export const renderInvoiceHTML = (document: InvoiceHTMLDocument, { locale = 'en' }: { locale?: string } = {}): string => {
  const currency = document.currency
  const money = (minor: number) => invoiceMoney(minor, currency, locale)
  const title = document.title ?? 'Invoice'
  const taxLabel = text(document.taxLabel)
  const issued = day(document.invoiceDate)
  const due = day(document.dueDate)

  const rows = document.lines
    .map((line) => {
      const gross = line.quantity * line.unitAmount
      const discount = line.discountAmount ?? 0
      const amount = gross - discount
      const detail = [
        discount > 0 ? `Less discount ${money(discount)}` : null,
        line.taxAmount ? `Tax ${money(line.taxAmount)}` : null,
      ]
        .filter((entry): entry is string => entry !== null)
        .map((entry) => `<div class="detail">${escapeHTML(entry)}</div>`)
        .join('')

      return (
        '<tr>' +
        `<td>${escapeHTML(line.description)}${detail}</td>` +
        `<td class="num">${escapeHTML(String(line.quantity))}</td>` +
        `<td class="num">${escapeHTML(money(line.unitAmount))}</td>` +
        `<td class="num">${escapeHTML(money(amount))}</td>` +
        '</tr>'
      )
    })
    .join('')

  const meta = [
    issued ? `<div><dt>Invoice date</dt><dd>${escapeHTML(issued)}</dd></div>` : '',
    due ? `<div><dt>Due</dt><dd>${escapeHTML(due)}</dd></div>` : '',
    document.invoiceNumber ? `<div><dt>Invoice number</dt><dd>${escapeHTML(document.invoiceNumber)}</dd></div>` : '',
    `<div><dt>Reference</dt><dd>${escapeHTML(document.reference)}</dd></div>`,
  ].join('')

  return `<!doctype html>
<html lang="${escapeHTML(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHTML(title)} ${escapeHTML(document.reference)}</title>
<style>
:root { color-scheme: light }
body { background: #f5f5f5; color: #1a1a1a; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 2rem 1rem }
main { background: #fff; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,.12); margin: 0 auto; max-width: 46rem; padding: 2rem }
header { align-items: baseline; display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; margin-bottom: 1.5rem }
h1 { font-size: 1.5rem; margin: 0 }
.parties { display: flex; flex-wrap: wrap; gap: 3rem; margin-bottom: 1.5rem }
.party h2 { font-size: .75rem; letter-spacing: .06em; margin: 0 0 .35rem; text-transform: uppercase; opacity: .65 }
dl { display: flex; flex-wrap: wrap; gap: .5rem 2rem; margin: 0 0 1.5rem; padding: 0 }
dt { font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; opacity: .65 }
dd { margin: 0 }
table { border-collapse: collapse; width: 100% }
th, td { border-bottom: 1px solid #e5e5e5; padding: .6rem .5rem; text-align: left; vertical-align: top }
th { font-size: .75rem; letter-spacing: .06em; text-transform: uppercase; opacity: .65 }
.num { text-align: right; white-space: nowrap }
.detail { font-size: .8rem; opacity: .7 }
tfoot th, tfoot td { border-bottom: 0; font-weight: 600 }
tfoot tr.total th, tfoot tr.total td { border-top: 1px solid #1a1a1a; font-size: 1.05rem }
footer { font-size: .8rem; opacity: .7; margin-top: 2rem; white-space: pre-line }
@media print { body { background: #fff; padding: 0 } main { box-shadow: none; margin: 0; max-width: none } }
</style>
</head>
<body>
<main>
<header><h1>${escapeHTML(title)}</h1><span>${escapeHTML(document.reference)}</span></header>
<dl>${meta}</dl>
<div class="parties">${party(document.issuer, 'From')}${party(document.payer, 'To')}</div>
<table>
<thead><tr><th scope="col">Description</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Unit</th><th scope="col" class="num">Amount</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot>${
    document.taxTotal && taxLabel
      ? `<tr><th scope="row" colspan="3">${escapeHTML(taxLabel)}</th><td class="num">${escapeHTML(money(document.taxTotal))}</td></tr>`
      : ''
  }<tr class="total"><th scope="row" colspan="3">Total</th><td class="num">${escapeHTML(money(document.total))}</td></tr></tfoot>
</table>
<footer>Amounts are in ${escapeHTML(currency)}${
    taxLabel && document.taxTotal === undefined ? `. This invoice does not include ${escapeHTML(taxLabel)}` : ''
  }.</footer>
${document.notes ? `<footer>${escapeHTML(document.notes)}</footer>` : ''}
</main>
</body>
</html>
`
}

/** A safe download name for the invoice, e.g. `invoice-order-12.html`. */
export const invoiceFileName = (reference: string): string => {
  const slug = reference
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

  return `invoice-${slug || 'order'}.html`
}
