import { describe, expect, it } from 'vitest'

import { renderInvoiceHTML, escapeHTML, invoiceFileName, invoiceMoney, type InvoiceHTMLDocument } from './invoice-html'

/** Intl puts a non-breaking space between the symbol and the digits; compare in plain spaces. */
const plain = (value: string): string => value.replace(/\u00a0/g, ' ')

const invoice = (extra: Partial<InvoiceHTMLDocument> = {}): InvoiceHTMLDocument => ({
  currency: 'VUV',
  dueDate: '2026-12-05',
  invoiceDate: '2026-11-21T00:00:00',
  issuer: { email: 'accounts@ycv.example.invalid', name: 'Youth Challenge Vanuatu' },
  lines: [
    { description: 'Basic: Brewer', quantity: 1, unitAmount: 3900 },
    { description: 'Featured', quantity: 1, unitAmount: 1500 },
    { description: 'Coupon SAVE10', quantity: 1, unitAmount: -540 },
  ],
  payer: { addressLines: ['PO Box 12', 'Port Vila'], email: 'accounts@brew.example.invalid', name: 'Brew' },
  reference: 'Order 7',
  taxLabel: 'VAT',
  total: 4860,
  ...extra,
})

describe('invoice money @S-171', () => {
  it('prints whole minor units in the currency’s own places', () => {
    expect(plain(invoiceMoney(3900, 'VUV'))).toBe('VUV 3,900')
    expect(plain(invoiceMoney(1999, 'NZD'))).toBe('$19.99')
    expect(plain(invoiceMoney(-540, 'VUV'))).toBe('-VUV 540')
    // Three decimal places (KWD), still from the digits rather than a float.
    expect(plain(invoiceMoney(1234, 'KWD'))).toBe('KWD 1.234')
  })

  it('refuses an amount that is not whole minor units', () => {
    expect(() => invoiceMoney(39.5, 'VUV')).toThrow(/whole minor units/)
  })
})

describe('invoice HTML for an order @S-171', () => {
  it('is a complete, unindexed page carrying the lines and the total', () => {
    const html = plain(renderInvoiceHTML(invoice()))

    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).toContain('VUV 3,900')
    expect(html).toContain('VUV 1,500')
    expect(html).toContain('-VUV 540')
    expect(html).toContain('VUV 4,860')
    expect(html).toContain('Youth Challenge Vanuatu')
    expect(html).toContain('PO Box 12')
    expect(html).toContain('Invoice date')
    expect(html).toContain('2026-11-21')
    expect(html).toContain('2026-12-05')
  })

  it('never fetches anything and never ships a script', () => {
    const html = renderInvoiceHTML(invoice())

    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('escapes every value that comes from the document', () => {
    const html = renderInvoiceHTML(
      invoice({
        issuer: { name: 'Youth Challenge <Vanuatu>' },
        lines: [{ description: '<img src=x onerror="alert(1)">', quantity: 1, unitAmount: 100 }],
        notes: '</main><script>alert(1)</script>',
        payer: { name: 'Brew & Co "Ltd"' },
        reference: 'Order <7>',
      }),
    )

    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).toContain('Brew &amp; Co &quot;Ltd&quot;')
    expect(html).toContain('Order &lt;7&gt;')
  })

  it('shows the discount and tax detail under a line, and no tax note without a tax label', () => {
    const withDetail = plain(renderInvoiceHTML(
      invoice({
        currency: 'NZD',
        lines: [{ description: 'Listing', discountAmount: 100, quantity: 1, taxAmount: 135, unitAmount: 1000 }],
        taxLabel: 'GST',
        total: 1035,
      }),
    ))

    expect(withDetail).toContain('Less discount $1.00')
    expect(withDetail).toContain('Tax $1.35')
    expect(withDetail).toContain('does not include GST')

    const untaxed = renderInvoiceHTML(invoice({ taxLabel: null }))
    expect(untaxed).not.toContain('does not include')
  })

  it('prints a document with no numbers, dates or parties without failing', () => {
    const html = plain(renderInvoiceHTML({
      currency: 'VUV',
      lines: [{ description: 'Listing', quantity: 1, unitAmount: 3900 }],
      reference: 'Order 1',
      total: 3900,
    }))

    expect(html).toContain('VUV 3,900')
    expect(html).not.toContain('Invoice date')
    expect(html).not.toContain('Send to')
  })
})

describe('invoice helpers', () => {
  it('escapes the five HTML characters and leaves the rest', () => {
    expect(escapeHTML(`<a href="x">Tom & Jerry's</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;')
  })

  it('makes a safe download name from any reference', () => {
    expect(invoiceFileName('Order 7')).toBe('invoice-order-7.html')
    expect(invoiceFileName('../../etc/passwd')).toBe('invoice-etc-passwd.html')
    expect(invoiceFileName('   ')).toBe('invoice-order.html')
    expect(invoiceFileName('x'.repeat(200)).length).toBeLessThanOrEqual(80)
  })
})
