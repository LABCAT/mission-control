import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { MoneyError, percentOf, sumMinorUnits } from './money'
import {
  PricingError,
  quote,
  snapshotQuote,
  type QuotableAddOn,
  type QuotablePlan,
  type QuoteArgs,
  type QuoteCouponTerms,
} from './pricing'
import type { TaxSettings } from './tax'

// Amounts up to 10^12 minor units: far beyond any real price, still well inside safe integers
// even when several are summed.
const money = fc.integer({ min: 0, max: 1_000_000_000_000 })
const days = fc.integer({ min: 1, max: 3650 })
const currency = fc.constantFrom('VUV', 'NZD', 'USD')

const planArb = (cur: string): fc.Arbitrary<QuotablePlan> =>
  fc.record({
    acceptsCredits: fc.option(fc.boolean(), { nil: undefined }),
    creditExpiryDays: fc.option(days, { nil: null }),
    currency: fc.constant(cur),
    durationDays: days,
    id: fc.integer({ min: 1, max: 1000 }),
    jobCredits: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 50 })),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    price: money,
    status: fc.constant('active' as const),
  })

const addOnArb = (cur: string, id: number): fc.Arbitrary<QuotableAddOn> =>
  fc.record({
    active: fc.constant(true),
    currency: fc.constant(cur),
    durationDays: days,
    id: fc.constant(id),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    placement: fc.constantFrom(null, 'featured-in-listings', 'featured-in-category'),
    price: money,
  })

const couponArb: fc.Arbitrary<QuoteCouponTerms> = fc.oneof(
  fc.record({
    active: fc.option(fc.boolean(), { nil: undefined }),
    amount: fc.integer({ min: 1, max: 100 }),
    discountType: fc.constant('percent'),
    maxUses: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    useCount: fc.integer({ min: 0, max: 6 }),
  }),
  fc.record({
    active: fc.option(fc.boolean(), { nil: undefined }),
    amount: fc.integer({ min: 1, max: 2_000_000_000_000 }),
    discountType: fc.constant('flat'),
    maxUses: fc.option(fc.integer({ min: 1, max: 5 }), { nil: null }),
    useCount: fc.integer({ min: 0, max: 6 }),
  }),
  // Bad data that skipped validation must never produce a discount.
  fc.record({
    amount: fc.oneof(fc.constant(null), fc.constant(0), fc.constant(-5), fc.constant(2.5)),
    discountType: fc.constantFrom('flat', 'percent', 'bogus'),
  }),
)

const argsArb: fc.Arbitrary<QuoteArgs> = currency.chain((cur) =>
  fc.record({
    addOns: fc
      .uniqueArray(fc.integer({ min: 1001, max: 2000 }), { maxLength: 3 })
      .chain((ids) => fc.tuple(...ids.map((id) => addOnArb(cur, id)))),
    availableCredits: fc.integer({ min: 0, max: 20 }),
    coupon: fc.option(couponArb, { nil: null }),
    plan: planArb(cur).chain((plan) =>
      fc
        .uniqueArray(fc.integer({ min: 2001, max: 3000 }), { maxLength: 2 })
        .chain((ids) => fc.tuple(...ids.map((id) => addOnArb(cur, id))))
        .chain((included) =>
          fc.record({
            durations: fc.tuple(...included.map(() => fc.option(days, { nil: null }))),
            included: fc.constant(included),
          }),
        )
        .map(({ durations, included }) => ({
          ...plan,
          includedAddOns: included.map((addOn, index) => ({
            addOn,
            durationDays: durations[index],
          })),
        })),
    ),
  }),
)

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Independent reference for half-up percentage rounding. */
const referencePercent = (amount: number, percent: number): number => {
  const scaled = BigInt(amount) * BigInt(percent)
  const quotient = scaled / 100n
  return Number(scaled % 100n >= 50n ? quotient + 1n : quotient)
}

describe('percentOf (shared with applyCoupon)', () => {
  it('rounds half up, exactly, for every safe amount', () => {
    fc.assert(
      fc.property(fc.maxSafeNat(), fc.integer({ min: 0, max: 100 }), (amount, percent) => {
        const result = percentOf(amount, percent)
        expect(result).toBe(referencePercent(amount, percent))
        expect(Number.isSafeInteger(result)).toBe(true)
        expect(result).toBeGreaterThanOrEqual(0)
        expect(result).toBeLessThanOrEqual(amount)
      }),
    )
  })

  it('agrees with applyCoupon’s Math.round wherever that float maths is exact', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000_000 }), fc.integer({ min: 0, max: 100 }), (a, p) => {
        expect(percentOf(a, p)).toBe(Math.round((a * p) / 100))
      }),
    )
  })

  it('handles the tie cases in both 0- and 2-decimal currencies', () => {
    expect(percentOf(25, 10)).toBe(3) // Vt 2.5 → Vt 3
    expect(percentOf(5, 50)).toBe(3) // $0.025 → $0.03
    expect(percentOf(149, 1)).toBe(1) // 1.49 → 1
    expect(percentOf(150, 1)).toBe(2) // 1.5 → 2
    expect(percentOf(999, 100)).toBe(999)
    expect(percentOf(999, 0)).toBe(0)
  })

  it('rejects fractional, negative and out-of-range input', () => {
    expect(() => percentOf(1.5, 10)).toThrow(MoneyError)
    expect(() => percentOf(-1, 10)).toThrow(MoneyError)
    expect(() => percentOf(Number.MAX_SAFE_INTEGER + 1, 10)).toThrow(MoneyError)
    expect(() => percentOf(100, 101)).toThrow(MoneyError)
    expect(() => percentOf(100, 12.5)).toThrow(MoneyError)
  })

  it('refuses sums that would lose precision', () => {
    expect(() => sumMinorUnits([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError)
  })
})

describe('quote invariants (property-based)', () => {
  it('only ever returns whole, non-negative money that adds up', () => {
    fc.assert(
      fc.property(argsArb, (args) => {
        const result = quote(args)
        const amounts = [
          result.subtotal,
          result.discount,
          result.total,
          result.credits.discount,
          result.coupon?.discount ?? 0,
          ...result.lines.flatMap((line) => [line.amount, line.unitPrice]),
        ]

        for (const amount of amounts) {
          expect(Number.isSafeInteger(amount)).toBe(true)
          expect(amount).toBeGreaterThanOrEqual(0)
        }

        expect(result.subtotal).toBe(result.lines.reduce((sum, line) => sum + line.amount, 0))
        expect(result.discount).toBe(result.credits.discount + (result.coupon?.discount ?? 0))
        expect(result.discount).toBeLessThanOrEqual(result.subtotal)
        expect(result.total).toBe(result.subtotal - result.discount)
        expect(result.currency).toBe(args.plan.currency)
      }),
    )
  })

  it('is deterministic and never mutates its input', () => {
    fc.assert(
      fc.property(argsArb, (args) => {
        const before = structuredClone(args)
        const first = quote(deepFreeze(structuredClone(args)))
        const second = quote(args)

        expect(second).toEqual(first)
        expect(args).toEqual(before)
      }),
    )
  })

  it('charges included add-ons nothing and paid add-ons their price', () => {
    fc.assert(
      fc.property(argsArb, (args) => {
        const result = quote(args)
        const included = result.lines.filter((line) => line.included)
        const paid = result.lines.filter((line) => line.kind === 'add-on' && !line.included)

        expect(included.every((line) => line.amount === 0)).toBe(true)
        expect(included).toHaveLength(args.plan.includedAddOns?.length ?? 0)
        expect(paid.map((line) => line.amount)).toEqual((args.addOns ?? []).map((a) => a.price))
        expect(result.lines[0]).toMatchObject({ amount: args.plan.price, kind: 'plan' })
        expect(result.entitlements.addOns).toHaveLength(included.length + paid.length)
      }),
    )
  })

  it('uses at most one credit, only for a priced single listing that accepts credits', () => {
    fc.assert(
      fc.property(argsArb, ({ plan, ...rest }) => {
        const result = quote({ plan, ...rest })
        const eligible = plan.jobCredits === 1 && plan.acceptsCredits !== false && plan.price > 0
        const expectUsed = eligible && (rest.availableCredits ?? 0) >= 1 ? 1 : 0

        expect(result.credits.used).toBe(expectUsed)
        expect(result.credits.discount).toBe(expectUsed ? plan.price : 0)
        expect(result.entitlements.jobCreditsGranted).toBe(expectUsed ? 0 : plan.jobCredits)
      }),
    )
  })

  it('applies a coupon to what is left after credits, with the shared rounding', () => {
    fc.assert(
      fc.property(argsArb, (args) => {
        const result = quote(args)
        const base = result.subtotal - result.credits.discount
        const coupon = args.coupon

        if (!coupon) {
          expect(result.coupon).toBeNull()
          expect(result.total).toBe(base)
          return
        }

        const usable =
          coupon.active !== false &&
          !(coupon.maxUses != null && (coupon.useCount ?? 0) >= coupon.maxUses) &&
          Number.isSafeInteger(coupon.amount) &&
          (coupon.amount ?? 0) >= 1 &&
          (coupon.discountType === 'flat' ||
            (coupon.discountType === 'percent' && (coupon.amount ?? 0) <= 100))

        if (!usable) {
          expect(result.coupon?.applied).toBe(false)
          expect(result.coupon?.discount).toBe(0)
          expect(result.total).toBe(base)
          return
        }

        const expected =
          coupon.discountType === 'flat'
            ? Math.min(coupon.amount ?? 0, base)
            : referencePercent(base, coupon.amount ?? 0)

        expect(result.coupon).toMatchObject({ applied: true, discount: expected, reason: null })
        expect(result.total).toBe(base - expected)
      }),
    )
  })

  it('never lets more credits or a bigger coupon make the total go up', () => {
    fc.assert(
      fc.property(argsArb, fc.integer({ min: 0, max: 5 }), (args, extra) => {
        const withoutCoupon = quote({ ...args, coupon: null })
        const withMoreCredits = quote({ ...args, availableCredits: (args.availableCredits ?? 0) + extra })

        expect(quote(args).total).toBeLessThanOrEqual(withoutCoupon.total)
        expect(withMoreCredits.total).toBeLessThanOrEqual(quote(args).total)
      }),
    )
  })

  it('snapshots to plain JSON that later changes to the inputs cannot reach', () => {
    fc.assert(
      fc.property(argsArb, (args) => {
        const live = structuredClone(args)
        const snapshot = snapshotQuote(quote(live))
        const copy = JSON.parse(JSON.stringify(snapshot))

        // An admin edits and archives the plan, and the add-ons change price.
        live.plan.price += 1
        live.plan.name = 'Renamed'
        live.plan.status = 'archived'
        for (const addOn of live.addOns ?? []) (addOn as { price: number }).price += 1

        expect(snapshot).toEqual(copy)
        expect(snapshot.version).toBe(1)
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.lines[0])).toBe(true)
        expect(snapshot.plan.price).toBe(args.plan.price)
      }),
    )
  })
})

const vatu = (overrides: Partial<QuotablePlan> = {}): QuotablePlan => ({
  currency: 'VUV',
  durationDays: 30,
  id: 1,
  jobCredits: 1,
  key: 'regular-listing',
  name: 'Regular listing',
  price: 5000,
  status: 'active',
  ...overrides,
})

const enhanced: QuotableAddOn = {
  active: true,
  currency: 'VUV',
  durationDays: 30,
  id: 'enhanced',
  name: 'Enhanced',
  placement: 'featured-in-listings',
  price: 2000,
}

describe('quote examples', () => {
  it('prices a Vatu listing with an add-on and a 10% coupon', () => {
    const result = quote({
      addOns: [enhanced],
      coupon: { amount: 10, code: 'LINKPS', discountType: 'percent', id: 7 },
      currency: 'VUV',
      plan: vatu({ price: 4995 }),
    })

    expect(result.subtotal).toBe(6995)
    expect(result.coupon).toMatchObject({ applied: true, code: 'LINKPS', discount: 700, id: 7 })
    expect(result.total).toBe(6295)
    expect(result.entitlements).toEqual({
      addOns: [
        {
          durationDays: 30,
          grantedBy: null,
          name: 'Enhanced',
          placement: 'featured-in-listings',
          ref: { id: 'enhanced', key: null, legacyId: null },
          source: 'purchase',
        },
      ],
      creditExpiryDays: null,
      jobCreditsGranted: 1,
      listingDays: 30,
    })
  })

  it('prices a 2-decimal currency in cents', () => {
    const result = quote({
      coupon: { amount: 15, discountType: 'percent' },
      plan: vatu({ currency: 'NZD', price: 1999 }),
    })

    // 15% of $19.99 is $2.9985, which rounds to $3.00.
    expect(result.coupon?.discount).toBe(300)
    expect(result.total).toBe(1699)
  })

  it('pays a single listing with a credit but still charges the add-on', () => {
    const result = quote({ addOns: [enhanced], availableCredits: 3, plan: vatu() })

    expect(result.credits).toEqual({ available: 3, discount: 5000, used: 1 })
    expect(result.total).toBe(2000)
    expect(result.entitlements.jobCreditsGranted).toBe(0)
  })

  it('does not spend a credit on a free plan, a pack, or a plan that refuses credits', () => {
    expect(quote({ availableCredits: 1, plan: vatu({ price: 0 }) }).credits.used).toBe(0)
    expect(quote({ availableCredits: 1, plan: vatu({ jobCredits: 10 }) }).credits.used).toBe(0)
    expect(quote({ availableCredits: 1, plan: vatu({ acceptsCredits: false }) }).credits.used).toBe(0)
  })

  it('grants a pack’s credits with their expiry', () => {
    const result = quote({ plan: vatu({ creditExpiryDays: 365, jobCredits: 10, price: 40000 }) })

    expect(result.entitlements).toMatchObject({ creditExpiryDays: 365, jobCreditsGranted: 10 })
    expect(result.total).toBe(40000)
  })

  it('caps a flat coupon at the amount due', () => {
    const result = quote({ coupon: { amount: 999_999, discountType: 'flat' }, plan: vatu() })

    expect(result.coupon?.discount).toBe(5000)
    expect(result.total).toBe(0)
  })

  it('explains a coupon that does not apply instead of throwing', () => {
    const plan = vatu()

    expect(quote({ coupon: { active: false, amount: 10, discountType: 'flat' }, plan }).coupon?.reason).toBe(
      'inactive',
    )
    expect(
      quote({ coupon: { amount: 10, discountType: 'flat', maxUses: 2, useCount: 2 }, plan }).coupon?.reason,
    ).toBe('used-up')
    expect(quote({ coupon: { amount: 0, discountType: 'flat' }, plan }).coupon?.reason).toBe(
      'invalid-amount',
    )
    expect(quote({ coupon: { amount: 101, discountType: 'percent' }, plan }).coupon?.reason).toBe(
      'invalid-amount',
    )
    expect(quote({ coupon: { amount: 10, discountType: 'bogof' }, plan }).coupon?.reason).toBe(
      'unsupported-discount-type',
    )
  })

  it('charges included add-ons nothing and uses the plan’s duration for them', () => {
    const result = quote({
      plan: vatu({ includedAddOns: [{ addOn: { ...enhanced, active: false }, durationDays: 14 }] }),
    })

    expect(result.lines[1]).toMatchObject({ amount: 0, durationDays: 14, included: true, unitPrice: 2000 })
    expect(result.total).toBe(5000)
    expect(result.entitlements.addOns[0]).toMatchObject({ durationDays: 14, source: 'plan' })
  })
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(PricingError)
    return (error as PricingError).code
  }
  return undefined
}

describe('quote rejects what cannot be sold', () => {
  it('refuses an archived plan', () => {
    expect(codeOf(() => quote({ plan: vatu({ status: 'archived' }) }))).toBe('plan-archived')
  })

  it('refuses mixed currencies', () => {
    expect(codeOf(() => quote({ currency: 'NZD', plan: vatu() }))).toBe('currency-mismatch')
    expect(codeOf(() => quote({ addOns: [{ ...enhanced, currency: 'NZD' }], plan: vatu() }))).toBe(
      'currency-mismatch',
    )
  })

  it('refuses inactive, duplicate and already-included add-ons', () => {
    expect(codeOf(() => quote({ addOns: [{ ...enhanced, active: false }], plan: vatu() }))).toBe(
      'add-on-inactive',
    )
    expect(codeOf(() => quote({ addOns: [enhanced, { ...enhanced }], plan: vatu() }))).toBe(
      'duplicate-add-on',
    )
    expect(
      codeOf(() => quote({ addOns: [enhanced], plan: vatu({ includedAddOns: [{ addOn: enhanced }] }) })),
    ).toBe('add-on-included')
  })

  it('refuses malformed money and counts', () => {
    expect(codeOf(() => quote({ plan: vatu({ price: 49.5 }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ plan: vatu({ price: -1 }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ plan: vatu({ durationDays: 0 }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ plan: vatu({ jobCredits: 0 }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ plan: vatu({ currency: 'vt' }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ addOns: [{ ...enhanced, price: 1.5 }], plan: vatu() }))).toBe(
      'invalid-add-on',
    )
    expect(codeOf(() => quote({ availableCredits: -1, plan: vatu() }))).toBe('invalid-credits')
    expect(codeOf(() => quote({ availableCredits: 0.5, plan: vatu() }))).toBe('invalid-credits')
    expect(
      codeOf(() => quote({ coupon: { amount: 5, discountType: 'flat', useCount: -1 }, plan: vatu() })),
    ).toBe('invalid-coupon')
  })
})

type ArbJobType = null | string | { id: string; isVolunteer: boolean }

const typeIDOf = (type: ArbJobType): null | string => (typeof type === 'object' && type ? type.id : type)

/** Independent statement of the rules: null means allowed, otherwise the expected code. */
const expectedRefusal = (
  plan: { allowedJobCategories: string[]; allowedJobTypes: string[]; isVolunteer: boolean },
  job: null | { categories: string[]; type: ArbJobType },
): null | string => {
  const restricted =
    plan.isVolunteer || plan.allowedJobTypes.length > 0 || plan.allowedJobCategories.length > 0
  if (!restricted) return null
  if (!job) return 'job-required'
  if (plan.isVolunteer) {
    if (job.type === null) return 'job-not-allowed'
    // Only the populated type document can show the job is voluntary.
    if (typeof job.type === 'string') return 'invalid-job'
    if (!job.type.isVolunteer) return 'job-not-allowed'
  }
  const typeID = typeIDOf(job.type)
  if (plan.allowedJobTypes.length > 0 && (typeID === null || !plan.allowedJobTypes.includes(typeID))) {
    return 'job-not-allowed'
  }
  if (plan.allowedJobCategories.length > 0) {
    if (job.categories.length === 0) return 'job-not-allowed'
    if (!job.categories.every((c) => plan.allowedJobCategories.includes(c))) return 'job-not-allowed'
  }
  return null
}

describe('plan restrictions (property-based)', () => {
  const slug = fc.constantFrom('full-time', 'contract', 'voluntary', 'health', 'education', 'ngo')
  const slugs = fc.uniqueArray(slug, { maxLength: 3 })

  const restrictedArb = fc.record({
    allowedJobCategories: slugs,
    allowedJobTypes: slugs,
    isVolunteer: fc.boolean(),
  })
  // The type arrives as a bare id or as the populated document with its own flag.
  const typeArb: fc.Arbitrary<ArbJobType> = fc.oneof(
    fc.constant(null),
    slug,
    fc.record({ id: slug, isVolunteer: fc.boolean() }),
  )
  const jobArb = fc.option(fc.record({ categories: slugs, type: typeArb }), { nil: null })

  it('sells a plan for a job exactly when every restriction allows it', () => {
    fc.assert(
      fc.property(argsArb, restrictedArb, jobArb, (args, restrictions, job) => {
        const plan = { ...args.plan, ...restrictions }
        const expected = expectedRefusal(restrictions, job)
        const code = codeOf(() => quote({ ...args, job, plan }))

        expect(code).toBe(expected ?? undefined)
      }),
    )
  })

  it('does not change the price when a job is allowed, and records the job on the quote', () => {
    fc.assert(
      fc.property(argsArb, jobArb, (args, job) => {
        // An unrestricted plan allows any job, so the job only adds context to the quote.
        const withJob = quote({ ...args, job })
        const without = quote(args)

        expect(withJob.total).toBe(without.total)
        expect(withJob.lines).toEqual(without.lines)
        expect(withJob.job).toEqual(
          job
            ? {
                categories: job.categories,
                isVolunteer: typeof job.type === 'object' && job.type ? job.type.isVolunteer : null,
                type: typeIDOf(job.type),
              }
            : null,
        )
      }),
    )
  })
})

describe('plan restrictions (examples)', () => {
  const volunteer = vatu({ acceptsCredits: false, isVolunteer: true, key: 'volunteer-listing', price: 0 })

  it('lets a voluntary job use the free volunteer plan', () => {
    const result = quote({ job: { type: { id: 'voluntary', isVolunteer: true } }, plan: volunteer })

    expect(result.total).toBe(0)
    expect(result.plan).toMatchObject({ isVolunteer: true })
    expect(result.job).toEqual({ categories: [], isVolunteer: true, type: 'voluntary' })
  })

  it('refuses the volunteer plan for a paid job, or with no job at all', () => {
    expect(
      codeOf(() => quote({ job: { type: { id: 'full-time', isVolunteer: false } }, plan: volunteer })),
    ).toBe('job-not-allowed')
    expect(codeOf(() => quote({ job: { type: { id: 'full-time' } }, plan: volunteer }))).toBe(
      'job-not-allowed',
    )
    expect(codeOf(() => quote({ job: {}, plan: volunteer }))).toBe('job-not-allowed')
    expect(codeOf(() => quote({ plan: volunteer }))).toBe('job-required')
  })

  it('limits a plan to its job types', () => {
    const contractOnly = vatu({ allowedJobTypes: ['contract'] })

    expect(quote({ job: { type: 'contract' }, plan: contractOnly }).total).toBe(5000)
    expect(codeOf(() => quote({ job: { type: 'full-time' }, plan: contractOnly }))).toBe('job-not-allowed')
    expect(codeOf(() => quote({ job: {}, plan: contractOnly }))).toBe('job-not-allowed')
  })

  it('needs every category on the job to be allowed', () => {
    const health = vatu({ allowedJobCategories: ['health', 'ngo'] })

    expect(quote({ job: { categories: ['health', 'ngo'] }, plan: health }).total).toBe(5000)
    expect(codeOf(() => quote({ job: { categories: ['health', 'education'] }, plan: health }))).toBe(
      'job-not-allowed',
    )
    expect(codeOf(() => quote({ job: { categories: [] }, plan: health }))).toBe('job-not-allowed')
  })

  it('compares ids, whether the plan and job hold ids or populated documents', () => {
    const plan = vatu({ allowedJobCategories: [{ id: 3 }], allowedJobTypes: [7, { id: 8 }] })

    expect(quote({ job: { categories: [3], type: { id: 8 } }, plan }).job).toEqual({
      categories: [3],
      isVolunteer: false,
      type: 8,
    })
    expect(quote({ job: { categories: [{ id: '3' }], type: '7' }, plan }).total).toBe(5000)
    expect(codeOf(() => quote({ job: { categories: [3], type: 9 }, plan }))).toBe('job-not-allowed')
  })

  it('only trusts the populated job type to say a job is voluntary', () => {
    const voluntaryType = { id: 5, isVolunteer: true }

    expect(quote({ job: { type: voluntaryType }, plan: volunteer }).job?.isVolunteer).toBe(true)
    // A bare id can't show it, and a caller-supplied flag is refused rather than trusted.
    expect(codeOf(() => quote({ job: { type: 5 }, plan: volunteer }))).toBe('invalid-job')
    expect(
      codeOf(() => quote({ job: { isVolunteer: true } as never, plan: volunteer })),
    ).toBe('invalid-job')
    expect(
      codeOf(() => quote({ job: { isVolunteer: true, type: 5 } as never, plan: volunteer })),
    ).toBe('invalid-job')
    expect(
      codeOf(() => quote({ job: { type: { id: 5, isVolunteer: 'yes' as never } }, plan: volunteer })),
    ).toBe('invalid-job')
    expect(codeOf(() => quote({ job: { type: { id: 6, isVolunteer: false } }, plan: volunteer }))).toBe(
      'job-not-allowed',
    )
  })

  it('lets an unrestricted pack be quoted without a job', () => {
    expect(quote({ plan: vatu({ jobCredits: 10, price: 40000 }) }).job).toBeNull()
  })

  it('snapshots the restrictions and the job, so the order shows what was allowed', () => {
    const plan = vatu({ allowedJobTypes: ['contract'] })
    const snapshot = snapshotQuote(quote({ job: { categories: ['ngo'], type: 'contract' }, plan }))
    ;(plan.allowedJobTypes as string[]).push('full-time')

    expect(snapshot.plan.allowedJobTypes).toEqual(['contract'])
    expect(snapshot.job).toEqual({ categories: ['ngo'], isVolunteer: null, type: 'contract' })
  })

  it('rejects malformed restrictions and jobs', () => {
    expect(codeOf(() => quote({ plan: vatu({ allowedJobTypes: [''] }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ plan: vatu({ isVolunteer: 'yes' as never }) }))).toBe('invalid-plan')
    expect(codeOf(() => quote({ job: { categories: 'ngo' as never }, plan: vatu() }))).toBe('invalid-job')
    expect(codeOf(() => quote({ job: { type: {} as never }, plan: vatu() }))).toBe('invalid-job')
    expect(codeOf(() => quote({ job: { type: 1.5 }, plan: vatu() }))).toBe('invalid-job')
  })
})

describe('add-on grants', () => {
  const premium: QuotableAddOn = {
    active: true,
    currency: 'VUV',
    durationDays: 14,
    grants: [{ addOn: enhanced, durationDays: 30 }],
    id: 'premium',
    name: 'Premium',
    placement: 'featured-in-category',
    price: 5000,
  }

  it('gives Premium’s 30 days of Enhanced for free, recorded as a grant', () => {
    const result = quote({ addOns: [premium], plan: vatu() })

    expect(result.total).toBe(10000)
    expect(result.lines.map((line) => line.name)).toEqual(['Regular listing', 'Premium'])
    expect(result.entitlements.addOns).toEqual([
      {
        durationDays: 14,
        grantedBy: null,
        name: 'Premium',
        placement: 'featured-in-category',
        ref: { id: 'premium', key: null, legacyId: null },
        source: 'purchase',
      },
      {
        durationDays: 30,
        grantedBy: { id: 'premium', key: null, legacyId: null },
        name: 'Enhanced',
        placement: 'featured-in-listings',
        ref: { id: 'enhanced', key: null, legacyId: null },
        source: 'grant',
      },
    ])
  })

  it('follows grants from add-ons a plan includes, resolving ids from the catalog', () => {
    const premiumByID = { ...premium, grants: [{ addOn: 'enhanced', durationDays: 30 }] }
    const plan = vatu({ includedAddOns: [{ addOn: 'premium' }] })

    const result = quote({ addOnCatalog: [enhanced, premiumByID], plan })

    expect(result.total).toBe(5000)
    expect(result.entitlements.addOns.map((row) => [row.ref.id, row.source, row.durationDays])).toEqual([
      ['premium', 'plan', 14],
      ['enhanced', 'grant', 30],
    ])
  })

  it('refuses an add-on given by id that is not in the catalog', () => {
    expect(codeOf(() => quote({ plan: vatu({ includedAddOns: [{ addOn: 'premium' }] }) }))).toBe(
      'invalid-add-on',
    )
    expect(
      codeOf(() =>
        quote({ addOns: [{ ...premium, grants: [{ addOn: 'ghost', durationDays: 30 }] }], plan: vatu() }),
      ),
    ).toBe('invalid-add-on')
  })

  it('cuts grant cycles instead of looping, and never grants the root to itself', () => {
    const a = { ...enhanced, grants: [] as { addOn: string; durationDays: number }[], id: 'a', name: 'A' }
    const b = { ...enhanced, grants: [{ addOn: 'c', durationDays: 5 }], id: 'b', name: 'B' }
    const c = { ...enhanced, grants: [{ addOn: 'a', durationDays: 5 }, { addOn: 'b', durationDays: 5 }], id: 'c', name: 'C' }
    a.grants = [{ addOn: 'b', durationDays: 5 }]

    const result = quote({ addOnCatalog: [a, b, c], addOns: [a], plan: vatu() })

    expect(result.entitlements.addOns.map((row) => [row.ref.id, row.source])).toEqual([
      ['a', 'purchase'],
      ['b', 'grant'],
      ['c', 'grant'],
    ])
  })

  it('honours grants of add-ons that are no longer sold, but not other currencies or bad durations', () => {
    const retired = { ...premium, grants: [{ addOn: { ...enhanced, active: false }, durationDays: 30 }] }
    expect(quote({ addOns: [retired], plan: vatu() }).entitlements.addOns).toHaveLength(2)

    expect(
      codeOf(() =>
        quote({
          addOns: [{ ...premium, grants: [{ addOn: { ...enhanced, currency: 'NZD' }, durationDays: 30 }] }],
          plan: vatu(),
        }),
      ),
    ).toBe('currency-mismatch')
    expect(
      codeOf(() => quote({ addOns: [{ ...premium, grants: [{ addOn: enhanced, durationDays: 0 }] }], plan: vatu() })),
    ).toBe('invalid-add-on')
  })

  it('never charges for a grant (property)', () => {
    const chain = fc.array(fc.record({ durationDays: days, price: money }), { minLength: 1, maxLength: 5 })

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), chain, fc.boolean(), (planPrice, links, cyclic) => {
        // A chain of add-ons, each granting the next; optionally the last grants the first.
        const ids = links.map((_, index) => `g${index}`)
        const catalog: QuotableAddOn[] = links.map((link, index) => ({
          active: true,
          currency: 'VUV',
          durationDays: link.durationDays,
          grants:
            index + 1 < links.length
              ? [{ addOn: ids[index + 1], durationDays: link.durationDays }]
              : cyclic
                ? [{ addOn: ids[0], durationDays: link.durationDays }]
                : [],
          id: ids[index],
          name: ids[index],
          placement: 'featured-in-listings',
          price: link.price,
        }))

        const result = quote({ addOnCatalog: catalog, addOns: [catalog[0]], plan: vatu({ price: planPrice }) })

        expect(result.subtotal).toBe(planPrice + links[0].price)
        expect(result.entitlements.addOns.map((row) => row.ref.id)).toEqual(ids)
        expect(result.entitlements.addOns.slice(1).every((row) => row.source === 'grant')).toBe(true)
      }),
    )
  })
})

const vatSettings = (overrides: Partial<TaxSettings> = {}): TaxSettings => ({
  defaultRateKey: 'vat',
  enabled: true,
  exemptXeroTaxType: 'EXEMPTOUTPUT',
  label: 'VAT',
  pricesIncludeTax: false,
  rates: [{ key: 'vat', name: 'VAT', rate: 1500, xeroTaxType: 'OUTPUT' }],
  rounding: 'invoice',
  ...overrides,
})

describe('quote with tax', () => {
  it('adds exclusive VAT after the coupon, line by line', () => {
    const result = quote({
      addOns: [enhanced],
      coupon: { amount: 10, discountType: 'percent' },
      plan: vatu(),
      tax: vatSettings(),
    })

    // 7000 subtotal, 700 coupon spread 500/200, 15% on 6300 = 945.
    expect(result.lines.map((line) => [line.discount, line.net, line.tax, line.gross])).toEqual([
      [500, 4500, 675, 5175],
      [200, 1800, 270, 2070],
    ])
    expect(result.tax).toMatchObject({ enabled: true, gross: 7245, label: 'VAT', net: 6300, tax: 945 })
    expect(result.total).toBe(7245)
  })

  it('carves inclusive VAT out of the price without changing what is paid', () => {
    const result = quote({ plan: vatu({ price: 5750 }), tax: vatSettings({ pricesIncludeTax: true }) })

    expect(result.total).toBe(5750)
    expect(result.tax).toMatchObject({ net: 5000, tax: 750 })
  })

  it('charges no tax on what a credit pays, nor on exempt add-ons', () => {
    const result = quote({
      addOns: [{ ...enhanced, taxExempt: true }],
      availableCredits: 1,
      plan: vatu(),
      tax: vatSettings(),
    })

    expect(result.lines.map((line) => [line.tax, line.xeroTaxType])).toEqual([
      [0, 'OUTPUT'],
      [0, 'EXEMPTOUTPUT'],
    ])
    expect(result.total).toBe(2000)
  })

  it('refuses a plan naming a rate the tenant does not have', () => {
    expect(codeOf(() => quote({ plan: vatu({ taxRateKey: 'ghost' }), tax: vatSettings() }))).toBe('invalid-tax')
    expect(codeOf(() => quote({ plan: vatu(), tax: vatSettings({ rates: [] }) }))).toBe('invalid-tax')
  })

  it('keeps every money invariant with any tax settings (property)', () => {
    const taxArb = fc.record({
      enabled: fc.boolean(),
      pricesIncludeTax: fc.boolean(),
      rate: fc.integer({ min: 0, max: 5000 }),
      rounding: fc.constantFrom('invoice' as const, 'line' as const),
    })

    fc.assert(
      fc.property(argsArb, taxArb, ({ ...args }, { enabled, pricesIncludeTax, rate, rounding }) => {
        const tax = vatSettings({ enabled, pricesIncludeTax, rates: [{ key: 'vat', name: 'VAT', rate }], rounding })
        const result = quote({ ...args, tax })
        const untaxed = quote(args)

        expect(result.lines.reduce((acc, line) => acc + line.discount, 0)).toBe(result.discount)
        expect(result.lines.reduce((acc, line) => acc + line.gross, 0)).toBe(result.total)
        expect(result.tax.net + result.tax.tax).toBe(result.total)
        for (const line of result.lines) {
          expect(line.amount - line.discount).toBe(pricesIncludeTax ? line.gross : line.net)
          expect(line.discount).toBeLessThanOrEqual(line.amount)
        }
        // Prices, discounts and coupons don't depend on tax; only the total can grow by it.
        expect(result.discount).toBe(untaxed.discount)
        expect(result.subtotal).toBe(untaxed.subtotal)
        expect(result.total).toBe(
          enabled && !pricesIncludeTax ? untaxed.total + result.tax.tax : untaxed.total,
        )
        if (!enabled) expect(result.tax.tax).toBe(0)
      }),
    )
  })
})
