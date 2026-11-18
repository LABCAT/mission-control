import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { ADD_ON_PLACEMENTS, type AddOnPlacement } from './add-ons'
import {
  activePlacements,
  compareListings,
  expirePlacements,
  listingBadges,
  listingRank,
  placementsAfterPurchase,
  type JobPlacement,
  type PlacedJob,
} from './placements'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-18T12:00:00.000Z')
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString()

const row = (placement: AddOnPlacement, from: number, to: number, addOn = 'x'): JobPlacement => ({
  addOn,
  expiresAt: at(to),
  placement,
  startsAt: at(from),
})

/** Sorts a copy; `toSorted` is ES2023, past this package's lib. */
// oxlint-disable-next-line unicorn/no-array-sort
const sorted = <T>(items: T[], compare: (a: T, b: T) => number): T[] => [...items].sort(compare)

/** The latest expiry among a placement's rows, or 0. */
const latest = (rows: JobPlacement[], placement: AddOnPlacement) =>
  Math.max(0, ...rows.filter((r) => r.placement === placement).map((r) => Date.parse(r.expiresAt)))

const job = (id: number, placements: JobPlacement[] = [], publishedDaysAgo = 0): PlacedJob => ({
  id,
  placements,
  publishedAt: at(-publishedDaysAgo),
})

const placementArb = fc.constantFrom(...ADD_ON_PLACEMENTS)
const rowArb = fc
  .record({ from: fc.integer({ min: -60, max: 10 }), length: fc.integer({ min: 0, max: 90 }), placement: placementArb })
  .map(({ from, length, placement }) => row(placement, from, from + length))
const entitlementArb = fc.record({
  durationDays: fc.integer({ min: 1, max: 365 }),
  placement: fc.oneof(placementArb, fc.constant(null), fc.constant('somewhere-else')),
  ref: fc.record({ id: fc.integer({ min: 1, max: 9 }) }),
})

describe('activePlacements and badges', () => {
  it('counts only rows that have started and not ended, once each, in placement order', () => {
    const rows = [
      row('featured-in-category', -1, 5),
      row('featured-in-listings', -10, -1), // ended
      row('featured-in-listings', 2, 9), // not started
      row('featured-in-category', -3, 1), // duplicate kind
    ]

    expect(activePlacements(rows, NOW)).toEqual(['featured-in-category'])
    expect(listingBadges({ id: 1, placements: [...rows, row('featured-in-listings', 0, 1)] }, NOW)).toEqual([
      'featured-in-listings',
      'featured-in-category',
    ])
  })

  it('ends a placement exactly at its expiry', () => {
    expect(activePlacements([row('featured-in-listings', -1, 0)], NOW)).toEqual([])
  })

  it('ignores malformed rows', () => {
    const bad = [
      { expiresAt: at(5), placement: 'sideways', startsAt: at(-1) },
      { expiresAt: 'not a date', placement: 'featured-in-listings', startsAt: at(-1) },
      null,
    ] as never
    expect(activePlacements(bad, NOW)).toEqual([])
    expect(expirePlacements(bad, NOW)).toEqual([])
  })
})

describe('expirePlacements (property-based)', () => {
  it('keeps exactly the rows that have not ended, and is idempotent', () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), (rows) => {
        const kept = expirePlacements(rows, NOW)

        expect(kept).toEqual(rows.filter((r) => Date.parse(r.expiresAt) > NOW.getTime()))
        expect(expirePlacements(kept, NOW)).toEqual(kept)
        expect(activePlacements(kept, NOW)).toEqual(activePlacements(rows, NOW))
      }),
    )
  })
})

describe('placementsAfterPurchase', () => {
  it('starts a new placement now and runs it for the longest duration bought in the order', () => {
    const result = placementsAfterPurchase(
      [],
      [
        { durationDays: 7, placement: 'featured-in-listings', ref: { id: 'enhanced' } },
        { durationDays: 30, placement: 'featured-in-listings', ref: { id: 'enhanced-grant' } },
        { durationDays: 14, placement: 'featured-in-category', ref: { id: 'premium' } },
      ],
      NOW,
    )

    expect(result).toEqual([
      { addOn: 'enhanced-grant', expiresAt: at(30), placement: 'featured-in-listings', startsAt: at(0) },
      { addOn: 'premium', expiresAt: at(14), placement: 'featured-in-category', startsAt: at(0) },
    ])
  })

  it('extends a live placement from its current expiry and drops ended rows', () => {
    const result = placementsAfterPurchase(
      [row('featured-in-listings', -10, 5, 'old'), row('featured-in-category', -30, -1, 'ended')],
      [{ durationDays: 30, placement: 'featured-in-listings', ref: { id: 'new' } }],
      NOW,
    )

    expect(result).toEqual([
      { addOn: 'new', expiresAt: at(35), placement: 'featured-in-listings', startsAt: at(-10) },
    ])
  })

  it('never shortens or removes a live placement, and gives every bought placement its days (property)', () => {
    fc.assert(
      fc.property(
        fc.array(rowArb, { maxLength: 6 }),
        fc.array(entitlementArb, { maxLength: 6 }),
        (existing, entitlements) => {
          const before = existing.filter((r) => Date.parse(r.expiresAt) > NOW.getTime())
          const after = placementsAfterPurchase(existing, entitlements, NOW)

          for (const placement of ADD_ON_PLACEMENTS) {
            expect(latest(after, placement)).toBeGreaterThanOrEqual(latest(before, placement))

            const days = entitlements
              .filter((e) => e.placement === placement)
              .reduce((max, e) => Math.max(max, e.durationDays), 0)
            if (days > 0) {
              expect(latest(after, placement)).toBeGreaterThanOrEqual(NOW.getTime() + days * DAY)
              expect(activePlacements(after, NOW)).toContain(placement)
            }
          }

          expect(expirePlacements(after, NOW)).toEqual(after)
          expect(placementsAfterPurchase(existing, entitlements, NOW)).toEqual(after)
        },
      ),
    )
  })
})

describe('listing order', () => {
  it('puts category-featured jobs first on category pages, and listing-featured jobs first everywhere', () => {
    const plain = job(1, [], 0)
    const enhanced = job(2, [row('featured-in-listings', -1, 5)], 3)
    const premium = job(3, [row('featured-in-category', -1, 5)], 5)
    const expired = job(4, [row('featured-in-listings', -9, -1)], 1)

    const sort = (context: 'category' | 'listings') =>
      sorted([plain, enhanced, premium, expired], compareListings(context, NOW)).map((j) => j.id)

    expect(sort('category')).toEqual([3, 2, 1, 4])
    expect(sort('listings')).toEqual([2, 1, 4, 3])
    expect(listingRank(premium, 'listings', NOW)).toBe(0)
    expect(listingRank(premium, 'category', NOW)).toBe(2)
  })

  it('is a total, consistent order (property)', () => {
    const jobArb = fc.record({
      id: fc.integer({ min: 1, max: 50 }),
      placements: fc.array(rowArb, { maxLength: 3 }),
      publishedAt: fc.option(fc.integer({ min: -100, max: 0 }).map(at), { nil: null }),
    })

    fc.assert(
      fc.property(fc.array(jobArb, { maxLength: 8 }), fc.constantFrom('category', 'listings'), (jobs, context) => {
        const compare = compareListings(context as 'category' | 'listings', NOW)

        for (const a of jobs) {
          expect(compare(a, a)).toBe(0)
          for (const b of jobs) {
            // Antisymmetric (written as a sum so 0 and -0 compare equal).
            expect(Math.sign(compare(a, b)) + Math.sign(compare(b, a))).toBe(0)
          }
        }

        const ordered = sorted(jobs, compare)
        for (let i = 1; i < ordered.length; i++) {
          expect(listingRank(ordered[i - 1], context as 'category', NOW)).toBeGreaterThanOrEqual(
            listingRank(ordered[i], context as 'category', NOW),
          )
        }
      }),
    )
  })
})
