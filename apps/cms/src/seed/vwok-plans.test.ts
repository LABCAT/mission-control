import { describe, expect, it } from 'vitest'

import { planSeedProblems } from '@mission-control/payload-jobs'

import { vwokPlans } from './vwok-plans'

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
      { addOnKey: 'enhanced', durationDays: 30 },
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

  it('is complete: every price, duration and pack size is confirmed', () => {
    expect(planSeedProblems(vwokPlans)).toEqual([])
  })

  it('matches the live plans (query 1, 19 Nov): price in vatu, pack size and WordPress post id @S-200', () => {
    const live = Object.fromEntries(vwokPlans.map((plan) => [plan.legacyId, [plan.price, plan.jobCredits]]))
    expect(live).toEqual({ 26: [3900, 1], 28: [17500, 5], 31: [0, 1], 36082: [33000, 10], 36084: [5900, 1] })
  })

  it('never expires pack credits', () => {
    expect(vwokPlans.filter((plan) => plan.creditExpiryDays != null)).toEqual([])
  })
})
