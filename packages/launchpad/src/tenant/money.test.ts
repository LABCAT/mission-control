import { describe, expect, it } from 'vitest'

import {
  currencyMinorUnits,
  formatMoney,
  formatTenantMoney,
  type Money,
} from './money'

describe('currencyMinorUnits', () => {
  it('knows the common exponents', () => {
    expect(currencyMinorUnits('VUV')).toBe(0)
    expect(currencyMinorUnits('JPY')).toBe(0)
    expect(currencyMinorUnits('NZD')).toBe(2)
    expect(currencyMinorUnits('usd')).toBe(2)
    expect(currencyMinorUnits('KWD')).toBe(3)
  })
})

describe('formatMoney', () => {
  it('formats zero-decimal currencies without a fraction', () => {
    expect(formatMoney({ amountMinor: 1500, currency: 'VUV' }, { locale: 'en' })).toBe(
      'VUV\u00a01,500',
    )
    // 150000 minor units is 150000 VUV: VUV has no cents, so nothing is divided.
    expect(formatMoney({ amountMinor: 150000, currency: 'VUV' }, { locale: 'en' })).toBe(
      'VUV\u00a0150,000',
    )
  })

  it('formats two-decimal currencies from integer minor units', () => {
    expect(formatMoney({ amountMinor: 150050, currency: 'NZD' }, { locale: 'en' })).toBe(
      '$1,500.50',
    )
    expect(formatMoney({ amountMinor: 5, currency: 'NZD' }, { locale: 'en' })).toBe('$0.05')
    expect(formatMoney({ amountMinor: 0, currency: 'NZD' }, { locale: 'en' })).toBe('$0.00')
  })

  it('never loses a cent to floating point', () => {
    // 0.1 + 0.2 as minor units is exact; a float implementation would print 0.30000000000000004.
    const money: Money = { amountMinor: 30, currency: 'NZD' }
    expect(formatMoney(money, { locale: 'en' })).toBe('$0.30')
    expect(formatMoney({ amountMinor: 7, currency: 'NZD' }, { locale: 'en' })).toBe('$0.07')
  })

  it('handles negative amounts, for credits and refunds', () => {
    expect(formatMoney({ amountMinor: -1250, currency: 'NZD' }, { locale: 'en' })).toBe('-$12.50')
  })

  it('honours the tenant currency exponent when it overrides the ISO default', () => {
    expect(
      formatMoney({ amountMinor: 1500, currency: 'VUV' }, { locale: 'en', minorUnits: 2 }),
    ).toBe('VUV\u00a015.00')
  })

  it('refuses a fractional amount and an unknown currency', () => {
    expect(() => formatMoney({ amountMinor: 1.5, currency: 'NZD' })).toThrow(TypeError)
    expect(() => formatMoney({ amountMinor: 100, currency: 'dollars' })).toThrow(TypeError)
    expect(() => formatMoney({ amountMinor: 100, currency: 'NZD' }, { minorUnits: 4 })).toThrow(
      TypeError,
    )
  })
})

describe('formatTenantMoney', () => {
  it('takes the currency, exponent and locale from the tenant', () => {
    const tenant = {
      currency: 'VUV',
      currencyMinorUnits: 0,
      defaultLocale: 'en',
      locales: ['en'],
    }

    expect(formatTenantMoney(tenant, 50000)).toBe('VUV\u00a050,000')
  })

  it('refuses the aggregate tenant, which has no currency of its own', () => {
    expect(() => formatTenantMoney({}, 100)).toThrow(TypeError)
  })
})
