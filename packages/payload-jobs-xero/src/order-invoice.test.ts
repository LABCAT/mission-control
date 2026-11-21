import { describe, expect, it } from 'vitest'

import { invoiceInputProblems, XeroInvoiceError } from '@mission-control/payload-xero'

import { orderNeedsInvoice, orderToXeroInvoice, withXeroRef, type OrderInvoiceContext } from './order-invoice'

const context = (extra: Partial<OrderInvoiceContext> = {}): OrderInvoiceContext => ({
  contact: { code: null, email: 'accounts@brew.example.invalid', legacyUserId: 4521, name: 'Brew' },
  jobTitles: [],
  planName: 'Basic',
  reference: 'Order 7',
  settings: { accountCodes: { addOn: '226', discount: '227', plan: '225' } },
  ...extra,
})

const order = (extra: Record<string, unknown> = {}) => ({
  addOns: [],
  currency: 'VUV',
  discount: 0,
  id: 7,
  legacyId: null,
  paymentMethod: 'invoice',
  status: 'pending',
  subtotal: 3900,
  tax: 0,
  taxInclusive: false,
  taxLines: [],
  total: 3900,
  ...extra,
})

const quoteLine = (extra: Record<string, unknown>) => ({
  amount: 0,
  discount: 0,
  gross: 0,
  included: false,
  kind: 'plan',
  name: 'Basic',
  net: 0,
  tax: 0,
  unitPrice: 0,
  xeroTaxType: null,
  ...extra,
})

describe('which orders are invoiced @S-102', () => {
  it.each([
    ['a pending invoice order', {}, true],
    ['an invoiced order', { status: 'invoiced' }, true],
    ['a paid order', { status: 'paid' }, true],
    ['a purchase request not yet approved', { status: 'waiting_for_purchase' }, false],
    ['a cancelled order', { status: 'cancelled' }, false],
    ['a free order', { total: 0 }, false],
    ['an order paid with credits', { paymentMethod: 'credit', total: 0 }, false],
    ['a legacy import, already invoiced by WordPress', { legacyId: 9001 }, false],
  ])('%s: %s', (_label, extra, expected) => {
    expect(orderNeedsInvoice(order(extra))).toBe(expected)
    expect(orderToXeroInvoice(order(extra), context()) !== null).toBe(expected)
  })
})

describe('order → invoice @S-102', () => {
  it('maps vwok’s untaxed order: plan, add-on and coupon on their account codes', () => {
    const invoice = orderToXeroInvoice(
      order({
        couponCode: 'SAVE10',
        discount: 540,
        quote: {
          coupon: { applied: true, code: 'SAVE10', discount: 540 },
          credits: { discount: 0 },
          lines: [
            quoteLine({ amount: 3900, kind: 'plan', name: 'Basic' }),
            quoteLine({ amount: 1500, kind: 'add-on', name: 'Featured' }),
            quoteLine({ amount: 0, included: true, kind: 'add-on', name: 'Logo' }),
          ],
        },
        subtotal: 5400,
        total: 4860,
      }),
      context({ jobTitles: ['Brewer'] }),
    )

    expect(invoice).toEqual({
      confirmed: false,
      contact: context().contact,
      currency: 'VUV',
      expectedTotal: 4860,
      lineAmountTypes: 'NoTax',
      lines: [
        { accountCode: '225', description: 'Basic: Brewer', quantity: 1, unitAmount: 3900 },
        { accountCode: '226', description: 'Featured', quantity: 1, unitAmount: 1500 },
        { accountCode: '227', description: 'Coupon SAVE10', quantity: 1, unitAmount: -540 },
      ],
      reference: 'Order 7',
    })
    expect(invoiceInputProblems(invoice!)).toEqual([])
  })

  it('puts a partial credit on its own discount line', () => {
    const invoice = orderToXeroInvoice(
      order({
        discount: 3900,
        quote: {
          credits: { discount: 3900 },
          lines: [quoteLine({ amount: 3900 }), quoteLine({ amount: 1500, kind: 'add-on', name: 'Featured' })],
        },
        subtotal: 5400,
        total: 1500,
      }),
      context(),
    )

    expect(invoice?.lines.at(-1)).toEqual({ accountCode: '227', description: 'Job credit', quantity: 1, unitAmount: -3900 })
    expect(invoiceInputProblems(invoice!)).toEqual([])
  })

  it('builds the lines from the order itself when it has no quote snapshot', () => {
    const invoice = orderToXeroInvoice(
      order({ addOns: [{ amount: 1500, name: 'Featured' }, { amount: 0, name: 'Logo' }], subtotal: 5400, total: 5400 }),
      context(),
    )

    expect(invoice?.lines).toEqual([
      { accountCode: '225', description: 'Basic', quantity: 1, unitAmount: 3900 },
      { accountCode: '226', description: 'Featured', quantity: 1, unitAmount: 1500 },
    ])
    expect(invoiceInputProblems(invoice!)).toEqual([])
  })

  it('carries each taxed line’s tax, discount and Xero tax type from the quote', () => {
    const invoice = orderToXeroInvoice(
      order({
        currency: 'NZD',
        discount: 100,
        quote: {
          credits: { discount: 0 },
          lines: [quoteLine({ amount: 1000, discount: 100, tax: 135, xeroTaxType: 'OUTPUT2' })],
        },
        subtotal: 1000,
        tax: 135,
        taxLines: [{ gross: 1035, key: 'gst', name: 'GST', net: 900, rate: 1500, tax: 135, xeroTaxType: 'OUTPUT2' }],
        total: 1035,
      }),
      context(),
    )

    expect(invoice).toMatchObject({
      expectedTotal: 1035,
      lineAmountTypes: 'Exclusive',
      lines: [{ accountCode: '225', discountAmount: 100, taxAmount: 135, taxType: 'OUTPUT2', unitAmount: 1000 }],
    })
  })

  it('refuses a taxed order without its quote, and an order whose amounts are not whole', () => {
    expect(() => orderToXeroInvoice(order({ tax: 135, total: 4035 }), context())).toThrow(XeroInvoiceError)
    expect(() => orderToXeroInvoice(order({ total: 39.5 }), context())).toThrow(/whole minor units/)
  })

  it('is confirmed (authorisable) once the order is invoiced or paid', () => {
    expect(orderToXeroInvoice(order(), context())?.confirmed).toBe(false)
    expect(orderToXeroInvoice(order({ status: 'invoiced' }), context())?.confirmed).toBe(true)
    expect(orderToXeroInvoice(order({ status: 'paid' }), context())?.confirmed).toBe(true)
  })
})

describe('recording the invoice on the order @S-102', () => {
  const ID = '11111111-2222-4333-8444-555555555555'

  it('adds the Xero reference once, then only fills in its link', () => {
    const first = withXeroRef([{ externalId: 'x', provider: 'stripe' }], { invoiceId: ID, onlineUrl: null })
    expect(first).toEqual([
      { externalId: 'x', provider: 'stripe' },
      { externalId: ID, provider: 'xero', url: null },
    ])

    expect(withXeroRef(first, { invoiceId: ID, onlineUrl: null })).toBeNull()
    expect(withXeroRef(first, { invoiceId: ID, onlineUrl: 'https://in.xero.com/a' })?.[1]).toEqual({
      externalId: ID,
      provider: 'xero',
      url: 'https://in.xero.com/a',
    })
  })

  it('never replaces a recorded link with nothing', () => {
    expect(withXeroRef([{ externalId: ID, provider: 'xero', url: 'https://in.xero.com/a' }], { invoiceId: ID, onlineUrl: null })).toBeNull()
  })
})
