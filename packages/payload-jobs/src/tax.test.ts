import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { allocateProportionally, MoneyError, mulDivHalfUp } from './money'
import {
  computeTax,
  TAX_DISABLED,
  TaxError,
  taxOn,
  taxSettingsProblems,
  type TaxableItem,
  type TaxSettings,
} from './tax'

const money = fc.integer({ min: 0, max: 1_000_000_000 })
const rateBp = fc.integer({ min: 0, max: 5000 })

const settingsArb: fc.Arbitrary<TaxSettings> = fc
  .record({
    pricesIncludeTax: fc.boolean(),
    rates: fc.uniqueArray(fc.constantFrom('standard', 'reduced', 'zero'), { minLength: 1, maxLength: 3 }).chain((keys) =>
      fc.tuple(...keys.map((key) => rateBp.map((rate) => ({ key, name: key, rate, xeroTaxType: key.toUpperCase() })))),
    ),
    rounding: fc.constantFrom('invoice' as const, 'line' as const),
  })
  .map((settings) => ({
    ...settings,
    defaultRateKey: settings.rates[0].key,
    enabled: true,
    exemptXeroTaxType: 'EXEMPTOUTPUT',
  }))

const itemsFor = (settings: TaxSettings): fc.Arbitrary<TaxableItem[]> =>
  fc.array(
    fc.record({
      amount: money,
      taxExempt: fc.option(fc.boolean(), { nil: undefined }),
      taxRateKey: fc.option(fc.constantFrom(...settings.rates.map((rate) => rate.key)), { nil: null }),
    }),
    { maxLength: 6 },
  )

const caseArb = settingsArb.chain((settings) => fc.record({ items: itemsFor(settings), settings: fc.constant(settings) }))

const rateOf = (settings: TaxSettings, item: TaxableItem) =>
  item.taxExempt ? null : settings.rates.find((rate) => rate.key === (item.taxRateKey ?? settings.defaultRateKey))

describe('mulDivHalfUp and allocateProportionally', () => {
  it('rounds half up, exactly', () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 1, max: 200_000 }), (a, n, d) => {
        const big = BigInt(a) * BigInt(n)
        const expected = big % BigInt(d) * 2n >= BigInt(d) ? big / BigInt(d) + 1n : big / BigInt(d)
        if (expected > BigInt(Number.MAX_SAFE_INTEGER)) {
          expect(() => mulDivHalfUp(a, n, d)).toThrow(MoneyError)
        } else {
          expect(mulDivHalfUp(a, n, d)).toBe(Number(expected))
        }
      }),
    )
  })

  it('splits a total into whole parts that add up, in proportion, never to a zero weight', () => {
    fc.assert(
      fc.property(fc.array(money, { minLength: 1, maxLength: 8 }), fc.nat(), (weights, seed) => {
        const sum = weights.reduce((a, b) => a + b, 0)
        const total = sum === 0 ? 0 : seed % (sum + 1)
        const parts = allocateProportionally(total, weights)

        expect(parts.reduce((a, b) => a + b, 0)).toBe(total)
        parts.forEach((part, index) => {
          expect(Number.isSafeInteger(part) && part >= 0).toBe(true)
          if (weights[index] === 0) expect(part).toBe(0)
          if (sum > 0) expect(Math.abs(part - (total * weights[index]) / sum)).toBeLessThan(1)
          expect(part).toBeLessThanOrEqual(weights[index] === 0 ? 0 : total)
        })
      }),
    )
  })
})

describe('computeTax invariants (property-based)', () => {
  it('gives whole, non-negative net + tax = gross per line, and lines add up to the totals', () => {
    fc.assert(
      fc.property(caseArb, ({ items, settings }) => {
        const result = computeTax(items, settings)

        result.lines.forEach((line, index) => {
          for (const value of [line.net, line.tax, line.gross]) {
            expect(Number.isSafeInteger(value) && value >= 0).toBe(true)
          }
          expect(line.net + line.tax).toBe(line.gross)
          expect(settings.pricesIncludeTax ? line.gross : line.net).toBe(items[index].amount)
          if (rateOf(settings, items[index]) === null) expect(line.tax).toBe(0)
        })

        const sum = (key: 'gross' | 'net' | 'tax') => result.lines.reduce((acc, line) => acc + line[key], 0)
        expect([result.net, result.tax, result.gross]).toEqual([sum('net'), sum('tax'), sum('gross')])
        expect(result.breakdown.reduce((acc, row) => acc + row.tax, 0)).toBe(result.tax)
        expect(result.breakdown.reduce((acc, row) => acc + row.net, 0) + result.exemptNet).toBe(result.net)
      }),
    )
  })

  it('rounds each rate once on its total per invoice, and each line on its own per line', () => {
    fc.assert(
      fc.property(caseArb, ({ items, settings }) => {
        const result = computeTax(items, settings)

        for (const row of result.breakdown) {
          const rate = settings.rates.find((candidate) => candidate.key === row.key)!
          const amounts = items.filter((item) => rateOf(settings, item) === rate).map((item) => item.amount)
          const perLine = amounts.reduce((acc, amount) => acc + taxOn(amount, rate.rate, settings.pricesIncludeTax), 0)
          const onTotal = taxOn(amounts.reduce((a, b) => a + b, 0), rate.rate, settings.pricesIncludeTax)

          expect(row.tax).toBe(settings.rounding === 'invoice' ? onTotal : perLine)
          // Each line's rounding moves at most half a unit, and the total's another half.
          expect(Math.abs(perLine - onTotal)).toBeLessThanOrEqual(Math.ceil((amounts.length + 1) / 2))
        }
      }),
    )
  })

  it('agrees between tax-exclusive and tax-inclusive prices for the same sale', () => {
    fc.assert(
      fc.property(money, rateBp, fc.constantFrom('invoice' as const, 'line' as const), (net, rate, rounding) => {
        const base = { defaultRateKey: 'standard', enabled: true, rates: [{ key: 'standard', name: 'Standard', rate }], rounding }
        const exclusive = computeTax([{ amount: net }], { ...base, pricesIncludeTax: false })
        const inclusive = computeTax([{ amount: exclusive.gross }], { ...base, pricesIncludeTax: true })

        // Same gross; the split differs by at most the one minor unit rounding can move.
        expect(inclusive.gross).toBe(exclusive.gross)
        expect(Math.abs(inclusive.net - exclusive.net)).toBeLessThanOrEqual(1)
        expect(Math.abs(inclusive.tax - exclusive.tax)).toBeLessThanOrEqual(1)
      }),
    )
  })

  it('charges nothing and changes nothing when tax is off', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ amount: money, taxRateKey: fc.constant('missing') }), { maxLength: 5 }), (items) => {
        const result = computeTax(items, TAX_DISABLED)

        expect(result.tax).toBe(0)
        expect(result.lines.map((line) => [line.net, line.gross, line.rate, line.xeroTaxType])).toEqual(
          items.map((item) => [item.amount, item.amount, null, null]),
        )
      }),
    )
  })
})

const vat = (overrides: Partial<TaxSettings> = {}): TaxSettings => ({
  defaultRateKey: 'vat',
  enabled: true,
  exemptXeroTaxType: 'EXEMPTOUTPUT',
  label: 'VAT',
  pricesIncludeTax: false,
  rates: [{ key: 'vat', name: 'VAT', rate: 1500, xeroTaxType: 'OUTPUT' }],
  rounding: 'invoice',
  ...overrides,
})

describe('computeTax examples', () => {
  it('adds 15% VAT to Vatu prices, or carves it out of inclusive ones', () => {
    expect(computeTax([{ amount: 5000 }], vat())).toMatchObject({ gross: 5750, net: 5000, tax: 750 })
    expect(computeTax([{ amount: 5750 }], vat({ pricesIncludeTax: true }))).toMatchObject({
      gross: 5750,
      net: 5000,
      tax: 750,
    })
  })

  it('rounds cents half up, and invoice rounding can differ from line rounding', () => {
    // 15% of $0.03 is 0.45c each; three lines: per line 0+0+0, per invoice 15% of 9c = 1.35 → 1c.
    const items = [{ amount: 3 }, { amount: 3 }, { amount: 3 }]
    expect(computeTax(items, vat({ rounding: 'line' })).tax).toBe(0)
    expect(computeTax(items, vat()).tax).toBe(1)
    expect(computeTax(items, vat()).lines.map((line) => line.tax)).toEqual([1, 0, 0])
    expect(computeTax([{ amount: 1999 }], vat()).tax).toBe(300) // $2.9985 → $3.00
  })

  it('uses a line’s own rate, or none when it is exempt, with the Xero types', () => {
    const settings = vat({
      rates: [
        { key: 'vat', name: 'VAT', rate: 1500, xeroTaxType: 'OUTPUT' },
        { key: 'zero', name: 'Zero rated', rate: 0, xeroTaxType: 'ZERORATEDOUTPUT' },
      ],
    })
    const result = computeTax(
      [{ amount: 1000 }, { amount: 1000, taxRateKey: 'zero' }, { amount: 1000, taxExempt: true }],
      settings,
    )

    expect(result.lines.map((line) => [line.tax, line.rate?.key ?? null, line.xeroTaxType])).toEqual([
      [150, 'vat', 'OUTPUT'],
      [0, 'zero', 'ZERORATEDOUTPUT'],
      [0, null, 'EXEMPTOUTPUT'],
    ])
    expect(result.breakdown.map((row) => [row.key, row.net, row.tax])).toEqual([
      ['vat', 1000, 150],
      ['zero', 1000, 0],
    ])
    expect(result.exemptNet).toBe(1000)
  })

  it('refuses a gross too large to represent exactly, instead of returning it imprecise', () => {
    const max = Number.MAX_SAFE_INTEGER
    // Exclusive, 100%: net + tax would be 2 × MAX_SAFE_INTEGER.
    expect(() => computeTax([{ amount: max }], vat({ rates: [{ key: 'vat', name: 'VAT', rate: 10_000 }] }))).toThrow(
      TaxError,
    )
    // Two lines whose own grosses are fine but whose total is not.
    expect(() => computeTax([{ amount: max - 10 }, { amount: 20 }], vat({ rates: [{ key: 'vat', name: 'VAT', rate: 0 }] }))).toThrow(
      TaxError,
    )
    // Inclusive tax never adds to the price, so the same amount is fine.
    expect(computeTax([{ amount: max }], vat({ pricesIncludeTax: true })).gross).toBe(max)
  })

  it('refuses unusable settings and unknown rates', () => {
    expect(() => computeTax([{ amount: 1, taxRateKey: 'ghost' }], vat())).toThrow(TaxError)
    expect(() => computeTax([{ amount: 1 }], vat({ defaultRateKey: null }))).toThrow(/no default rate/)
    expect(() => computeTax([{ amount: 1.5 }], vat())).toThrow(TaxError)
    expect(taxSettingsProblems(vat({ rates: [] }))).toContain('tax is enabled but has no rates')
    expect(taxSettingsProblems(vat({ rounding: 'weekly' as never }))).toEqual(['rounding must be one of invoice, line'])
    expect(
      taxSettingsProblems(
        vat({
          rates: [
            { key: 'vat', name: 'VAT', rate: 1500 },
            { key: 'vat', name: 'Again', rate: 15.5 },
          ],
        }),
      ),
    ).toEqual(['rate "vat": key is used twice', 'rate "vat": rate must be whole basis points from 0 to 100000 (1500 is 15%)'])
  })
})
