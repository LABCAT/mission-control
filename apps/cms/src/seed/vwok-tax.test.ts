import { describe, expect, it } from 'vitest'

import { taxSeedProblems } from '@mission-control/payload-jobs'

import { vwokTax } from './vwok-tax'

describe('vwok tax seed', () => {
  it('names VAT as the default rate', () => {
    expect(vwokTax.defaultRateKey).toBe('vat')
    expect(vwokTax.rates.map((rate) => rate.key)).toEqual(['vat'])
  })

  it('only fails on values that are not confirmed yet, never on malformed ones', () => {
    const problems = taxSeedProblems(vwokTax)
    for (const problem of problems) expect(problem).toMatch(/not confirmed/)
  })
})
