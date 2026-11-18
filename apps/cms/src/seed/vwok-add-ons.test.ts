import { describe, expect, it } from 'vitest'

import { addOnSeedProblems, planSeedProblems } from '@mission-control/payload-jobs'

import { vwokAddOns } from './vwok-add-ons'
import { vwokPlans } from './vwok-plans'

describe('vwok add-on seed', () => {
  it('seeds Enhanced and Premium with their legacy meta keys and placements', () => {
    expect(vwokAddOns.map(({ key, legacyKey, placement }) => ({ key, legacyKey, placement }))).toEqual([
      { key: 'enhanced', legacyKey: '_jr_featured-listings', placement: 'featured-in-listings' },
      { key: 'premium', legacyKey: '_jr_featured-cat', placement: 'featured-in-category' },
    ])
  })

  it('has Premium grant 30 days of Enhanced', () => {
    expect(vwokAddOns.find((addOn) => addOn.key === 'premium')?.grants).toEqual([
      { addOnKey: 'enhanced', durationDays: 30 },
    ])
  })

  it('only fails on values that are not confirmed yet, never on malformed ones', () => {
    for (const problem of addOnSeedProblems(vwokAddOns)) {
      expect(problem).toMatch(/is not confirmed/)
    }
  })

  it('covers every add-on the plans include', () => {
    const keys = new Set(vwokAddOns.map((addOn) => addOn.key))
    for (const plan of vwokPlans) {
      for (const included of plan.includedAddOns ?? []) expect(keys).toContain(included.addOnKey)
    }
    expect(planSeedProblems(vwokPlans).every((problem) => /not confirmed/.test(problem))).toBe(true)
  })
})
