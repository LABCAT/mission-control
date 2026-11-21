import { describe, expect, it } from 'vitest'

import {
  canonicalOrderValue,
  orderCollection,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  orderFieldsFromQuote,
  orderMoneyProblems,
  orderStatusFromLegacy,
  orderTransitionProblem,
  type OrderActor,
} from './orders'
import { INVOICE_PAYMENT_PROVIDER, isRegisteredPaymentProvider, resolvePaymentProviders } from './payment-providers'
import { quote, snapshotQuote, type QuotableAddOn, type QuotablePlan } from './pricing'

const plan: QuotablePlan = {
  currency: 'NZD',
  durationDays: 30,
  id: 7,
  jobCredits: 1,
  key: 'regular-listing',
  name: 'Regular listing',
  price: 10_000,
  status: 'active',
}

const featured: QuotableAddOn = {
  active: true,
  currency: 'NZD',
  durationDays: 30,
  id: 21,
  key: 'enhanced',
  name: 'Enhanced',
  placement: 'featured-in-listings',
  price: 2_500,
}

const gst = {
  enabled: true,
  pricesIncludeTax: false,
  rates: [{ key: 'gst', name: 'GST', rate: 1500, xeroTaxType: 'OUTPUT2' }],
  defaultRateKey: 'gst',
  rounding: 'invoice' as const,
}

describe('order status transitions @S-146', () => {
  it('lets staff and system code follow the transition table and nothing else', () => {
    for (const actor of ['staff', 'system'] as OrderActor[]) {
      for (const from of ORDER_STATUSES) {
        for (const to of ORDER_STATUSES) {
          const allowed = from === to || ORDER_TRANSITIONS[from].includes(to)
          expect(orderTransitionProblem(from, to, actor) === null).toBe(allowed)
        }
      }
    }
  })

  it('keeps paid and cancelled final', () => {
    for (const to of ORDER_STATUSES) {
      if (to === 'paid') continue
      expect(orderTransitionProblem('paid', to, 'system')).not.toBeNull()
    }
    for (const to of ORDER_STATUSES) {
      if (to === 'cancelled') continue
      expect(orderTransitionProblem('cancelled', to, 'staff')).not.toBeNull()
    }
  })

  it('lets an owner only answer a purchase request', () => {
    expect(orderTransitionProblem('waiting_for_purchase', 'pending', 'owner')).toBeNull()
    expect(orderTransitionProblem('waiting_for_purchase', 'cancelled', 'owner')).toBeNull()
    expect(orderTransitionProblem('waiting_for_purchase', 'invoiced', 'owner')).toMatch(/site manager/)
    expect(orderTransitionProblem('pending', 'paid', 'owner')).toMatch(/site manager/)
    expect(orderTransitionProblem('invoiced', 'paid', 'owner')).toMatch(/site manager/)
  })

  it('never lets a member change the status', () => {
    expect(orderTransitionProblem('waiting_for_purchase', 'pending', 'member')).toMatch(/owner or a site manager/)
    expect(orderTransitionProblem('pending', 'pending', 'member')).toBeNull()
  })
})

describe('legacy order statuses @S-146', () => {
  it('imports a pending WordPress transaction as invoiced, not unpaid', () => {
    expect(orderStatusFromLegacy('tr_pending')).toBe('invoiced')
    expect(orderStatusFromLegacy('tr_completed')).toBe('paid')
    expect(orderStatusFromLegacy('tr_activated')).toBe('paid')
    expect(orderStatusFromLegacy('tr_failed')).toBe('failed')
  })

  it('knows nothing else', () => {
    expect(orderStatusFromLegacy('publish')).toBeNull()
    expect(orderStatusFromLegacy('toString')).toBeNull()
    expect(orderStatusFromLegacy(undefined)).toBeNull()
  })
})

describe('order money @S-146', () => {
  const money = {
    currency: 'NZD',
    discount: 1_000,
    subtotal: 10_000,
    tax: 1_350,
    taxInclusive: false,
    taxLines: [{ gross: 10_350, key: 'gst', name: 'GST', net: 9_000, rate: 1500, tax: 1_350 }],
    total: 10_350,
  }

  it('accepts money that adds up', () => {
    expect(orderMoneyProblems(money)).toEqual([])
    expect(
      orderMoneyProblems({ ...money, taxInclusive: true, total: 9_000, taxLines: [{ ...money.taxLines[0], gross: 10_350 }] }),
    ).toEqual([])
  })

  it('refuses fractions, negatives and unsafe numbers', () => {
    expect(orderMoneyProblems({ ...money, total: 10_350.5 }).map((e) => e.path)).toContain('total')
    expect(orderMoneyProblems({ ...money, discount: -1 }).map((e) => e.path)).toContain('discount')
    expect(orderMoneyProblems({ ...money, subtotal: 2 ** 60 }).map((e) => e.path)).toContain('subtotal')
    expect(orderMoneyProblems({ ...money, currency: 'vuv' }).map((e) => e.path)).toContain('currency')
  })

  it('refuses a total that does not add up', () => {
    expect(orderMoneyProblems({ ...money, total: 10_349 })).toEqual([
      expect.objectContaining({ path: 'total' }),
    ])
    expect(orderMoneyProblems({ ...money, discount: 10_001, total: 0 }).map((e) => e.path)).toContain('discount')
  })

  it('needs tax lines that add up to the tax', () => {
    expect(orderMoneyProblems({ ...money, taxLines: [] }).map((e) => e.path)).toContain('taxLines')
    expect(
      orderMoneyProblems({ ...money, taxLines: [{ ...money.taxLines[0], gross: 10_351, tax: 1_351 }] }).map((e) => e.path),
    ).toContain('tax')
    expect(
      orderMoneyProblems({ ...money, taxLines: [{ ...money.taxLines[0], gross: 1 }] }).map((e) => e.path),
    ).toContain('taxLines.0.gross')
  })
})

describe('orders from a quote snapshot @S-146', () => {
  it('takes the money, plan, add-ons, coupon and tax lines from the quote', () => {
    const snapshot = snapshotQuote(
      quote({
        addOns: [featured],
        coupon: { amount: 10, code: 'LINKPS', discountType: 'percent', id: 3 },
        currency: 'NZD',
        plan,
        tax: gst,
      }),
    )
    const fields = orderFieldsFromQuote(JSON.parse(JSON.stringify(snapshot)))

    expect(fields).toMatchObject({
      coupon: 3,
      couponCode: 'LINKPS',
      currency: 'NZD',
      discount: snapshot.discount,
      plan: 7,
      subtotal: 12_500,
      tax: snapshot.tax.tax,
      taxInclusive: false,
      total: snapshot.total,
    })
    expect(fields.addOns).toEqual([
      expect.objectContaining({ addOn: 21, amount: 2_500, included: false, key: 'enhanced', unitPrice: 2_500 }),
    ])
    expect(fields.taxLines).toEqual([expect.objectContaining({ key: 'gst', rate: 1500, xeroTaxType: 'OUTPUT2' })])
    expect(orderMoneyProblems(fields)).toEqual([])
  })

  it('leaves the coupon off when it was not applied', () => {
    const fields = orderFieldsFromQuote(
      snapshotQuote(quote({ coupon: { active: false, amount: 10, code: 'OFF', discountType: 'percent', id: 4 }, plan })),
    )
    expect(fields.coupon).toBeNull()
    expect(fields.couponCode).toBeNull()
    expect(fields.discount).toBe(0)
  })

  it('refuses something that is not a snapshot of this version', () => {
    expect(() => orderFieldsFromQuote(null)).toThrow(/quote snapshot/)
    expect(() => orderFieldsFromQuote({ ...snapshotQuote(quote({ plan })), version: 99 })).toThrow(/version/)
    expect(() => orderFieldsFromQuote({ version: 1 })).toThrow(/missing/)
  })
})

describe('canonicalOrderValue', () => {
  it('ignores key order, row ids and populated relationships', () => {
    expect(canonicalOrderValue({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalOrderValue({ a: { c: 3, d: 2 }, b: 1 }))
    expect(canonicalOrderValue([{ id: 'row1', key: 'gst', tax: 5 }])).toBe(canonicalOrderValue([{ key: 'gst', tax: 5 }]))
    expect(canonicalOrderValue({ createdAt: 'x', id: 5, name: 'Plan' })).toBe(canonicalOrderValue(5))
    expect(canonicalOrderValue(undefined)).toBe(canonicalOrderValue(null))
    expect(canonicalOrderValue(5)).not.toBe(canonicalOrderValue(6))
  })
})

describe('payment providers @S-146', () => {
  it('always registers invoice first', () => {
    expect(resolvePaymentProviders()).toEqual([INVOICE_PAYMENT_PROVIDER])
    expect(resolvePaymentProviders([{ key: 'stripe', label: 'Card' }]).map((p) => p.key)).toEqual(['invoice', 'stripe'])
  })

  it('refuses bad, duplicate or unlabelled keys', () => {
    expect(() => resolvePaymentProviders([{ key: 'Stripe', label: 'Card' }])).toThrow(/lowercase/)
    expect(() => resolvePaymentProviders([{ key: 'invoice', label: 'Mine' }])).toThrow(/twice/)
    expect(() => resolvePaymentProviders([{ key: 'stripe', label: ' ' }])).toThrow(/label/)
  })

  it('knows which keys are registered', () => {
    const providers = resolvePaymentProviders()
    expect(isRegisteredPaymentProvider('invoice', providers)).toBe(true)
    expect(isRegisteredPaymentProvider('paypal', providers)).toBe(false)
    expect(isRegisteredPaymentProvider(undefined, providers)).toBe(false)
  })
})

const fieldsJSON = (couponsEnabled: boolean) => JSON.stringify(orderCollection({ couponsEnabled }).fields)

describe('orders without coupons @S-146', () => {
  it('leaves out the coupon relationship when coupons are off, keeping the applied code', () => {
    const names = fieldsJSON
    expect(names(true)).toContain('"name":"coupon"')
    expect(names(false)).not.toContain('"name":"coupon"')
    expect(names(false)).toContain('"name":"couponCode"')
  })
})
