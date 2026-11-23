import { describe, expect, it } from 'vitest'

import { invoiceHTMLForOrder, tenantIssuer, type InvoiceTenant } from './invoice-link'

const tenant: InvoiceTenant = { defaultLocale: 'en', name: 'Youth Challenge Vanuatu', taxLabel: 'VAT' }

const order = (extra: Record<string, unknown> = {}) => ({
  addOns: [],
  createdAt: '2026-11-21T03:04:05.000Z',
  currency: 'VUV',
  discount: 0,
  id: 7,
  legacyId: null,
  organisation: { id: 3 },
  paymentMethod: 'invoice',
  status: 'invoiced',
  subtotal: 3900,
  tax: 0,
  taxInclusive: false,
  taxLines: [],
  total: 3900,
  ...extra,
})

const args = (extra: Record<string, unknown> = {}) => ({
  invoiceNumber: 'INV-0042',
  jobTitles: ['Brewer'],
  order: order(),
  organisation: { billingEmail: 'accounts@brew.example.invalid', name: 'Brew' },
  planName: 'Basic',
  reference: 'Order 7',
  tenant,
  ...extra,
})

/** Intl puts a non-breaking space between the symbol and the digits; compare in plain spaces. */
const plain = (value: string): string => value.replace(/\u00a0/g, ' ')

describe('HTML invoice fallback for an order @S-171', () => {
  it('renders the order money with the plan line, the payer and the invoice dates', () => {
    const invoice = invoiceHTMLForOrder(args({ dueDays: 14 }))!

    expect(invoice).toMatchObject({ currency: 'VUV', filename: 'invoice-order-7.html', reference: 'Order 7', total: 3900 })

    const html = plain(invoice.html)
    expect(html).toContain('Basic: Brewer')
    expect(html).toContain('VUV 3,900')
    expect(html).toContain('Youth Challenge Vanuatu')
    expect(html).toContain('Brew')
    expect(html).toContain('INV-0042')
    expect(html).toContain('2026-11-21')
    // 14 days after the invoice date, as calendar arithmetic rather than a clock.
    expect(html).toContain('2026-12-05')
    // With no tax on the order, the page says so instead of inventing a tax row.
    expect(html).toContain('does not include VAT')
  })

  it('renders discounts and a tax row for a taxed order, from the same lines as Xero', () => {
    const invoice = invoiceHTMLForOrder(
      args({
        order: order({
          currency: 'NZD',
          discount: 100,
          quote: {
            credits: { discount: 0 },
            lines: [
              { amount: 1000, discount: 100, kind: 'plan', name: 'Listing', tax: 135, xeroTaxType: 'OUTPUT2' },
            ],
          },
          subtotal: 1000,
          tax: 135,
          taxLines: [{ rate: 15, tax: 135 }],
          total: 1035,
        }),
        tenant: { ...tenant, taxLabel: 'GST' },
      }),
    )!

    const html = plain(invoice.html)
    expect(html).toContain('$10.00')
    expect(html).toContain('Less discount $1.00')
    // The tax is its own row before the total, and the line shows its own tax too.
    expect(html).toContain('<th scope="row" colspan="3">GST</th>')
    expect(html).toContain('Tax $1.35')
    expect(html).toContain('$10.35')
    // The tax is a row of its own, so the "does not include" note would be wrong.
    expect(html).not.toContain('does not include')
  })

  it('gives no fallback for an order that has no invoice', () => {
    expect(invoiceHTMLForOrder(args({ order: order({ total: 0 }) }))).toBeNull()
    expect(invoiceHTMLForOrder(args({ order: order({ legacyId: 9001 }) }))).toBeNull()
    expect(invoiceHTMLForOrder(args({ order: order({ paymentMethod: 'credit' }) }))).toBeNull()
    expect(invoiceHTMLForOrder(args({ order: order({ status: 'waiting_for_purchase' }) }))).toBeNull()
  })

  it('prints the tenant’s own issuer when one is given', () => {
    const invoice = invoiceHTMLForOrder(args({ issuer: () => ({ email: 'billing@vwok.example.invalid', name: 'vanuatuwok.vu' }) }))!

    expect(invoice.html).toContain('vanuatuwok.vu')
    expect(invoice.html).toContain('billing@vwok.example.invalid')
    expect(invoice.html).not.toContain('Youth Challenge Vanuatu')
  })

  it('falls back to the tenant’s name as the issuer', () => {
    expect(tenantIssuer({ name: '  Brew Ltd  ' })).toEqual({ name: 'Brew Ltd' })
    expect(tenantIssuer({ name: null })).toEqual({ name: null })
  })

  it('escapes the payer name and the reference', () => {
    const invoice = invoiceHTMLForOrder(
      args({
        organisation: { billingEmail: null, name: '<b>Brew</b> & Co' },
        reference: 'Order <7>',
      }),
    )!

    expect(invoice.html).not.toContain('<b>Brew</b>')
    expect(invoice.html).toContain('&lt;b&gt;Brew&lt;/b&gt; &amp; Co')
    expect(invoice.html).toContain('Order &lt;7&gt;')
    expect(invoice.filename).toBe('invoice-order-7.html')
  })
})
