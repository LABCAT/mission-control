import { describe, expect, it } from 'vitest'

import {
  currencyMinorUnits,
  formatMoney,
  formatTenantMoney,
  type Money,
} from './money'

describe('currencyMinorUnits', () => {
  it('takes the exponent from ICU, not a hand-kept list', () => {
    expect(currencyMinorUnits('VUV')).toBe(0)
    expect(currencyMinorUnits('VND')).toBe(0)
    expect(currencyMinorUnits('XOF')).toBe(0)
    expect(currencyMinorUnits('JPY')).toBe(0)
    expect(currencyMinorUnits('USD')).toBe(2)
    expect(currencyMinorUnits('NZD')).toBe(2)
    expect(currencyMinorUnits('KWD')).toBe(3)
    expect(currencyMinorUnits('usd')).toBe(2)
  })

  it('agrees with the fraction digits of the currency format it is used for', () => {
    for (const currency of ['VUV', 'VND', 'XOF', 'JPY', 'USD', 'NZD', 'KWD']) {
      const { maximumFractionDigits } = new Intl.NumberFormat('en', {
        currency,
        style: 'currency',
      }).resolvedOptions()

      expect(currencyMinorUnits(currency)).toBe(maximumFractionDigits)
    }
  })

  it('reports exponents outside the tenant range for the currencies that have them', () => {
    // The CMS override is capped at 0-3, but ICU knows CLF has four decimals. The derived
    // exponent is the currency's, so it is used as ICU reports it.
    expect(currencyMinorUnits('CLF')).toBe(4)
    expect(formatMoney({ amountMinor: 150000, currency: 'CLF' }, { locale: 'en' })).toBe(
      'CLF\u00a015.0000',
    )
  })

  it('falls back to two decimals for an unknown three-letter code, as ICU does', () => {
    expect(currencyMinorUnits('XYZ')).toBe(2)
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

  it('derives the omitted exponent from the currency itself', () => {
    // A tenant may omit `currencyMinorUnits`; the currency then decides what 150000 minor
    // units means. VUV, VND, XOF and JPY have none, so nothing is divided; USD has two.
    const amount = 150000
    const zeroDecimal = ['VUV', 'VND', 'XOF', 'JPY'] as const

    for (const currency of zeroDecimal) {
      const formatted = formatMoney({ amountMinor: amount, currency }, { locale: 'en' })

      expect(formatted.endsWith('150,000')).toBe(true)
      expect(formatted).not.toContain('.')
    }

    expect(formatMoney({ amountMinor: amount, currency: 'USD' }, { locale: 'en' })).toBe(
      '$1,500.00',
    )
  })

  it('formats the same minor units per the currency exponent it derived', () => {
    const amount = 150000

    for (const [currency, units] of [
      ['VND', 0],
      ['USD', 2],
    ] as const) {
      expect(formatMoney({ amountMinor: amount, currency }, { locale: 'en' })).toBe(
        formatMoney({ amountMinor: amount, currency }, { locale: 'en', minorUnits: units }),
      )
    }

    // The exponent is what differs, not the amount: 150000 VND is not 150000.00 USD.
    expect(formatMoney({ amountMinor: amount, currency: 'USD' }, { locale: 'en' })).not.toBe(
      formatMoney({ amountMinor: amount, currency: 'USD' }, { locale: 'en', minorUnits: 0 }),
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
