import { allocateProportionally, isMinorUnits, mulDivHalfUp, sumMinorUnits } from './money'

/**
 * Tax, configured per tenant (VAT in Vanuatu, GST in New Zealand, none on the hub). Pure: no
 * database, no clock. `quote()` calls `computeTax` after discounts, so tax is charged on what
 * the customer actually pays.
 *
 * - Rates are basis points: hundredths of a percent, so 1500 is 15% and 1250 is 12.5%.
 * - Prices are either tax-inclusive (the price is the gross, tax is carved out of it) or
 *   tax-exclusive (tax is added on top). Both give whole minor units with net + tax = gross.
 * - Rounding is per invoice (the default: each rate's tax is worked out once on that rate's
 *   total, then spread across its lines so they add up exactly) or per line (each line's tax is
 *   rounded on its own). Either way the shared half-up rule in `money.ts` is the only rounding.
 * - A line is taxed at its own rate (`taxRateKey`), the tenant's default, or not at all
 *   (`taxExempt`). Each rate carries the Xero tax type its invoice lines use (PJ-57).
 */

export const TAX_ROUNDING_MODES = ['invoice', 'line'] as const
export type TaxRoundingMode = (typeof TAX_ROUNDING_MODES)[number]

/** 100% in basis points. */
export const BASIS_POINTS_PER_WHOLE = 10_000

/** The highest rate accepted: 1000%. Anything above is a typo for basis points. */
export const MAX_TAX_RATE_BASIS_POINTS = 100_000

export const TAX_RATE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export type TaxRate = {
  /** Stable key, e.g. `standard`. Plans and add-ons name a rate by it. */
  key: string
  name: string
  /** Basis points: 1500 is 15%. */
  rate: number
  /** The Xero tax type for invoice lines at this rate, e.g. `OUTPUT`. */
  xeroTaxType?: null | string
}

export type TaxSettings = {
  /** The rate for lines that name none. Required when tax is enabled and any line is taxable. */
  defaultRateKey?: null | string
  enabled: boolean
  /** The Xero tax type for tax-exempt lines, e.g. `EXEMPTOUTPUT`. */
  exemptXeroTaxType?: null | string
  /** What the tenant calls it on prices and invoices: VAT, GST… */
  label?: null | string
  /** True: prices include tax. False: tax is added on top. */
  pricesIncludeTax: boolean
  rates: readonly TaxRate[]
  rounding: TaxRoundingMode
}

/** A tenant with tax switched off: every line is untaxed and net = gross. */
export const TAX_DISABLED: TaxSettings = Object.freeze({
  enabled: false,
  pricesIncludeTax: false,
  rates: Object.freeze([]) as readonly TaxRate[],
  rounding: 'invoice' as const,
})

/** How one line is taxed. */
export type TaxableItem = {
  /** What the customer pays for the line after discounts, in price terms (incl. or excl. tax). */
  amount: number
  taxExempt?: boolean | null
  taxRateKey?: null | string
}

export type LineTax = {
  gross: number
  net: number
  /** The rate applied, or `null` when the line is exempt or tax is off. */
  rate: null | { key: string; name: string; rate: number; xeroTaxType: null | string }
  tax: number
  /** The Xero tax type for the line: the rate's, or the exempt type. */
  xeroTaxType: null | string
}

export type TaxBreakdownRow = {
  gross: number
  key: string
  name: string
  net: number
  rate: number
  tax: number
  xeroTaxType: null | string
}

export type TaxResult = {
  /** Per rate, in the order the tenant lists its rates; only rates that were used. */
  breakdown: TaxBreakdownRow[]
  /** Net of exempt (and untaxed) lines. */
  exemptNet: number
  gross: number
  lines: LineTax[]
  net: number
  tax: number
}

export type TaxErrorCode = 'invalid-tax'

export class TaxError extends Error {
  readonly code: TaxErrorCode = 'invalid-tax'

  constructor(message: string) {
    super(message)
    this.name = 'TaxError'
  }
}

/** Problems with tax settings, one message per problem; empty when they are usable. */
export const taxSettingsProblems = (settings: TaxSettings): string[] => {
  const problems: string[] = []
  if (!settings || typeof settings !== 'object') return ['tax settings are missing']
  if (typeof settings.enabled !== 'boolean') problems.push('enabled must be true or false')
  if (typeof settings.pricesIncludeTax !== 'boolean') {
    problems.push('pricesIncludeTax must be true or false')
  }
  if (!(TAX_ROUNDING_MODES as readonly string[]).includes(settings.rounding)) {
    problems.push(`rounding must be one of ${TAX_ROUNDING_MODES.join(', ')}`)
  }
  if (!Array.isArray(settings.rates)) return [...problems, 'rates must be a list']

  const keys = new Set<string>()
  for (const rate of settings.rates) {
    const label = `rate "${rate?.key ?? '?'}"`
    if (typeof rate?.key !== 'string' || !TAX_RATE_KEY_PATTERN.test(rate.key)) {
      problems.push(`${label}: key must be kebab-case, e.g. standard`)
    } else if (keys.has(rate.key)) {
      problems.push(`${label}: key is used twice`)
    } else {
      keys.add(rate.key)
    }
    if (typeof rate?.name !== 'string' || !rate.name.trim()) problems.push(`${label}: name is required`)
    if (!Number.isSafeInteger(rate?.rate) || rate.rate < 0 || rate.rate > MAX_TAX_RATE_BASIS_POINTS) {
      problems.push(
        `${label}: rate must be whole basis points from 0 to ${MAX_TAX_RATE_BASIS_POINTS} (1500 is 15%)`,
      )
    }
  }

  const defaultKey = settings.defaultRateKey ?? null
  if (defaultKey !== null && !keys.has(defaultKey)) {
    problems.push(`the default rate "${defaultKey}" is not one of the rates`)
  }
  if (settings.enabled && settings.rates.length === 0) problems.push('tax is enabled but has no rates')

  return problems
}

export const assertTaxSettings = (settings: TaxSettings): void => {
  const problems = taxSettingsProblems(settings)
  if (problems.length > 0) throw new TaxError(`Tax settings: ${problems.join('; ')}`)
}

/** The tax on `amount` at `rate` basis points, in price terms (inclusive or exclusive). */
export const taxOn = (amount: number, rate: number, pricesIncludeTax: boolean): number =>
  pricesIncludeTax
    ? mulDivHalfUp(amount, rate, BASIS_POINTS_PER_WHOLE + rate)
    : mulDivHalfUp(amount, rate, BASIS_POINTS_PER_WHOLE)

const EXEMPT = Symbol('exempt')

/**
 * Tax a set of lines. Throws `TaxError` for unusable settings, a line naming an unknown rate,
 * or a taxable line with no rate to fall back on. With tax off every line is untaxed.
 */
export const computeTax = (items: readonly TaxableItem[], settings: TaxSettings = TAX_DISABLED): TaxResult => {
  assertTaxSettings(settings)
  for (const item of items) {
    if (!isMinorUnits(item?.amount)) {
      throw new TaxError('Every line amount must be whole minor units, 0 or more')
    }
  }

  const byKey = new Map(settings.rates.map((rate) => [rate.key, rate]))
  const exemptType = settings.exemptXeroTaxType ?? null

  // Which rate (or exemption) each line uses.
  const assigned = items.map((item): TaxRate | typeof EXEMPT => {
    if (!settings.enabled || item.taxExempt === true) return EXEMPT
    const key = item.taxRateKey ?? settings.defaultRateKey ?? null
    if (key === null) throw new TaxError('A taxable line has no tax rate and the tenant has no default rate')
    const rate = byKey.get(key)
    if (!rate) throw new TaxError(`Unknown tax rate "${key}"`)
    return rate
  })

  const taxes = items.map(() => 0)

  if (settings.rounding === 'line') {
    items.forEach((item, index) => {
      const rate = assigned[index]
      if (rate !== EXEMPT) taxes[index] = taxOn(item.amount, rate.rate, settings.pricesIncludeTax)
    })
  } else {
    // Per invoice: one tax per rate on the rate's total, spread back over its lines.
    for (const rate of settings.rates) {
      const indexes = assigned.flatMap((assignedRate, index) => (assignedRate === rate ? [index] : []))
      if (indexes.length === 0) continue
      const amounts = indexes.map((index) => items[index].amount)
      const groupTax = taxOn(sumMinorUnits(amounts), rate.rate, settings.pricesIncludeTax)
      allocateProportionally(groupTax, amounts).forEach((part, position) => {
        taxes[indexes[position]] = part
      })
    }
  }

  const lines: LineTax[] = items.map((item, index) => {
    const rate = assigned[index]
    const tax = taxes[index]
    const net = settings.pricesIncludeTax ? item.amount - tax : item.amount
    return {
      gross: net + tax,
      net,
      rate:
        rate === EXEMPT
          ? null
          : { key: rate.key, name: rate.name, rate: rate.rate, xeroTaxType: rate.xeroTaxType ?? null },
      tax,
      xeroTaxType: rate === EXEMPT ? (settings.enabled ? exemptType : null) : (rate.xeroTaxType ?? null),
    }
  })

  const breakdown: TaxBreakdownRow[] = settings.rates.flatMap((rate) => {
    const rows = lines.filter((_, index) => assigned[index] === rate)
    if (rows.length === 0) return []
    const net = sumMinorUnits(rows.map((row) => row.net))
    const tax = sumMinorUnits(rows.map((row) => row.tax))
    return [
      { gross: net + tax, key: rate.key, name: rate.name, net, rate: rate.rate, tax, xeroTaxType: rate.xeroTaxType ?? null },
    ]
  })

  const net = sumMinorUnits(lines.map((line) => line.net))
  const tax = sumMinorUnits(lines.map((line) => line.tax))

  return {
    breakdown,
    exemptNet: sumMinorUnits(lines.filter((_, index) => assigned[index] === EXEMPT).map((line) => line.net)),
    gross: net + tax,
    lines,
    net,
    tax,
  }
}
