import { describe, expect, it } from 'vitest'

import { planSeedProblems } from '@mission-control/payload-jobs'

import { vwokPlans } from './vwok-plans'

describe('vwok plan seed', () => {
  it('seeds exactly the plans that are still sold', () => {
    expect(vwokPlans.map((plan) => plan.key)).toEqual([
      'regular-listing',
      'job-pack',
      '10-job-pack',
      'volunteer-listing',
    ])
  })

  it('keeps volunteer listings free and never paid for with a credit', () => {
    expect(vwokPlans.find((plan) => plan.key === 'volunteer-listing')).toMatchObject({
      acceptsCredits: false,
      jobCredits: 1,
      price: 0,
    })
  })

  it('only fails on values that are not confirmed yet, never on malformed ones', () => {
    // Remove this test's allowance once the live prices are in: the seed must then be ready.
    for (const problem of planSeedProblems(vwokPlans)) {
      expect(problem).toMatch(/is not confirmed|are not confirmed/)
    }
  })
})
