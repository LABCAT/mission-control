/**
 * Integer money helpers shared by the pricing engine (`quote`) and coupons (`applyCoupon`).
 *
 * Every amount is a whole number of the tenant currency's minor units: VUV has 0 decimals, so
 * 500 is Vt 500, while NZD has 2, so 500 is $5.00. No floating-point money is ever stored or
 * returned. The only rounding in the system happens in `percentOf`, so a percentage gives the
 * same result wherever it is applied.
 */

export class MoneyError extends RangeError {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/** True for a whole number of minor units, 0 or more, that is exact in a JS number. */
export const isMinorUnits = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Throw unless `value` is a whole number of minor units, 0 or more. */
export function assertMinorUnits(value: unknown, label: string): asserts value is number {
  if (!isMinorUnits(value)) {
    throw new MoneyError(`${label} must be a whole number of minor units, 0 or more`)
  }
}

/** Add minor-unit amounts, throwing instead of losing precision past Number.MAX_SAFE_INTEGER. */
export const sumMinorUnits = (values: readonly number[]): number => {
  let total = 0

  for (const value of values) {
    assertMinorUnits(value, 'amount')
    total += value
    if (!Number.isSafeInteger(total)) throw new MoneyError('total is too large to represent exactly')
  }

  return total
}

/**
 * `percent`% of `amount`, rounded to the nearest minor unit with halves rounded up
 * (Vt 25 at 10% is Vt 3; $0.05 at 50% is $0.03).
 *
 * BigInt keeps the arithmetic exact for every safe integer, and it matches
 * `Math.round((amount * percent) / 100)` wherever that float expression is exact. Coupons and
 * the pricing engine must both use this, so a discount never differs by a minor unit between
 * the checkout and the invoice.
 */
export const percentOf = (amount: number, percent: number): number => {
  assertMinorUnits(amount, 'amount')
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new MoneyError('percent must be a whole number from 0 to 100')
  }

  return Number((BigInt(amount) * BigInt(percent) + 50n) / 100n)
}
