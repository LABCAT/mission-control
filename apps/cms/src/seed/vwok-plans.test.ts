import { describe, expect, it } from 'vitest'

import { planSeedProblems } from '@mission-control/payload-jobs'

import { VWOK_MAX_DURATION_DAYS, vwokPlans } from './vwok-plans'

describe('vwok plan seed', () => {
  it('seeds exactly the plans that are still sold', () => {
    expect(vwokPlans.map((plan) => plan.key)).toEqual([
      'regular-listing',
      'job-pack',
      '10-job-pack',
      'enhanced-listing',
      'volunteer-listing',
    ])
  })

  it('keeps Enhanced listing as a plan that includes the Enhanced add-on', () => {
    expect(vwokPlans.find((plan) => plan.key === 'enhanced-listing')?.includedAddOns).toEqual([
      { addOnKey: 'enhanced', durationDays: null },
    ])
  })

  it('keeps volunteer listings free, for voluntary jobs only, and never paid with a credit', () => {
    expect(vwokPlans.find((plan) => plan.key === 'volunteer-listing')).toMatchObject({
      acceptsCredits: false,
      isVolunteer: true,
      jobCredits: 1,
      price: 0,
    })
  })

  it('restricts no other plan to volunteer jobs', () => {
    expect(vwokPlans.filter((plan) => plan.isVolunteer).map((plan) => plan.key)).toEqual([
      'volunteer-listing',
    ])
  })

  it('lets every listing run for at most 45 days @S-190', () => {
    expect(VWOK_MAX_DURATION_DAYS).toBe(45)
    expect(vwokPlans.map((plan) => plan.durationDays)).toEqual(vwokPlans.map(() => 45))
  })

  it('only fails on values that are not confirmed yet, never on malformed ones', () => {
    // Remove this test's allowance once the live prices are in: the seed must then be ready.
    for (const problem of planSeedProblems(vwokPlans)) {
      expect(problem).toMatch(/is not confirmed|are not confirmed/)
    }
  })
})
