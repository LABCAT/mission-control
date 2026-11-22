import { describe, expect, it } from 'vitest'

import {
  CheckoutError,
  closeDateProblem,
  defaultPurchaseRights,
  endOfLocalDay,
  localDateOf,
  parseCheckoutInput,
  paymentMethodFor,
} from './checkout'

const NOW = new Date('2026-11-21T10:00:00.000Z')
const refused = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    return error instanceof CheckoutError ? error.code : 'other'
  }
  return null
}

describe('parseCheckoutInput', () => {
  it('reads ids, a normalised coupon code, a date and the credit flag @S-152', () => {
    expect(
      parseCheckoutInput({ addOnIds: [3, '4'], closeDate: '2026-12-01', couponCode: ' linkps ', jobId: 1, planId: '2', useCredit: true }),
    ).toEqual({ addOnIds: [3, '4'], closeDate: '2026-12-01', couponCode: 'LINKPS', jobId: 1, planId: '2', useCredit: true })
    expect(parseCheckoutInput({ jobId: 1, planId: 2 })).toEqual({
      addOnIds: [],
      closeDate: null,
      couponCode: null,
      jobId: 1,
      planId: 2,
      useCredit: false,
    })
  })

  it('drops amounts the client sends instead of trusting them @S-152', () => {
    const input = parseCheckoutInput({ discount: 999, jobId: 1, planId: 2, price: 0, total: 0 }) as Record<string, unknown>
    expect(input).not.toHaveProperty('total')
    expect(input).not.toHaveProperty('price')
    expect(input).not.toHaveProperty('discount')
  })

  it('refuses malformed bodies @S-152', () => {
    for (const body of [
      null,
      [],
      'x',
      { planId: 2 },
      { jobId: 1 },
      { jobId: -1, planId: 2 },
      { jobId: 1.5, planId: 2 },
      { jobId: 'a b', planId: 2 },
      { addOnIds: 'x', jobId: 1, planId: 2 },
      { addOnIds: [{}], jobId: 1, planId: 2 },
      { closeDate: '01/12/2026', jobId: 1, planId: 2 },
      { couponCode: 5, jobId: 1, planId: 2 },
      { jobId: 1, planId: 2, useCredit: 'yes' },
    ]) {
      expect(refused(() => parseCheckoutInput(body))).toBe('invalid_request')
    }
  })
})

describe('close date', () => {
  const problem = (closeDate: string, timeZone = 'Pacific/Efate') => closeDateProblem({ closeDate, durationDays: 45, now: NOW, timeZone })

  it('accepts a date after today up to the plan’s maximum, in the tenant’s timezone @S-031', () => {
    // 10:00 UTC is 21:00 on the 21st in Vanuatu; 45 days on is 5 January.
    expect(problem('2026-11-22')).toBeNull()
    expect(problem('2027-01-05')).toBeNull()
    expect(problem('2027-01-06')).toMatch(/at most 45 days/)
    expect(problem('2026-11-21')).toMatch(/after today/)
    expect(problem('2026-02-30')).toMatch(/not a real date/)
  })

  it('uses the tenant’s calendar day, not UTC’s @S-031', () => {
    const late = new Date('2026-11-21T14:00:00.000Z') // 22 November 01:00 in Vanuatu
    expect(closeDateProblem({ closeDate: '2026-11-22', durationDays: 45, now: late, timeZone: 'Pacific/Efate' })).toMatch(/after today/)
    expect(closeDateProblem({ closeDate: '2026-11-22', durationDays: 45, now: late, timeZone: 'UTC' })).toBeNull()
    // An unknown zone falls back to UTC rather than failing.
    expect(closeDateProblem({ closeDate: '2026-11-22', durationDays: 45, now: late, timeZone: 'Mars/Base' })).toBeNull()
  })

  it('closes at the end of the chosen day, across DST changes @S-031', () => {
    expect(endOfLocalDay('2026-12-01', 'Pacific/Efate')).toBe('2026-12-01T12:59:59.999Z')
    expect(endOfLocalDay('2026-12-01', 'UTC')).toBe('2026-12-01T23:59:59.999Z')
    // New Zealand: NZDT (+13) on 5 April 2026 ends at 03:00 local; that day closes at +12.
    expect(endOfLocalDay('2026-04-05', 'Pacific/Auckland')).toBe('2026-04-05T11:59:59.999Z')
    expect(endOfLocalDay('2026-04-04', 'Pacific/Auckland')).toBe('2026-04-04T10:59:59.999Z')
    expect(localDateOf(Date.parse('2026-12-01T12:59:59.999Z'), 'Pacific/Efate')).toBe('2026-12-01')
  })
})

describe('payment method', () => {
  it('is credit when a credit pays it all, free at zero, otherwise invoice @S-152', () => {
    expect(paymentMethodFor({ credits: { available: 1, discount: 3900, used: 1 }, total: 0 })).toBe('credit')
    expect(paymentMethodFor({ credits: { available: 0, discount: 0, used: 0 }, total: 0 })).toBe('free')
    expect(paymentMethodFor({ credits: { available: 1, discount: 3900, used: 1 }, total: 2000 })).toBe('invoice')
    expect(paymentMethodFor({ credits: { available: 0, discount: 0, used: 0 }, total: 1 })).toBe('invoice')
  })
})

describe('purchase rights', () => {
  const rights = (actor: 'member' | 'owner' | 'staff' | 'system', user: Record<string, unknown> | null = {}) =>
    defaultPurchaseRights({ actor, organisationID: 1, req: {} as never, user: user as never })

  it('lets members use credits but not buy unless the owner allows it @S-153', () => {
    expect(rights('member')).toEqual({ buy: false, useCredits: true })
    expect(rights('member', { canBuy: true })).toEqual({ buy: true, useCredits: true })
    expect(rights('member', { useCredits: false })).toEqual({ buy: false, useCredits: false })
    // Only an explicit true grants buying.
    expect(rights('member', { canBuy: 'yes' })).toEqual({ buy: false, useCredits: true })
    for (const actor of ['owner', 'staff', 'system'] as const) {
      expect(rights(actor, { canBuy: false, useCredits: false })).toEqual({ buy: true, useCredits: true })
    }
  })
})
