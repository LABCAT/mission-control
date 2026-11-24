import type { PlanSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's live plans (USAGE.md, founder decision 18 Nov 2026): every live plan someone
 * buys is kept: Regular listing, Job pack, 10 Job pack, Volunteer listing and Enhanced listing.
 * "Unlimited 6 month" is not built. Enhanced listing is a plan that includes the Enhanced
 * add-on (seeded from `vwok-add-ons.ts`, before the plans).
 *
 * Prices are VUV, which has no minor units, so 5000 is Vt 5,000.
 *
 * The values are the live `pricing-plan` posts (query 1 of QUERY-RESULTS-19NOV.md: price,
 * duration, pack size, post ID), copied in exactly. `legacyId` is the WordPress post id the order
 * import (PJ-65) links legacy orders to; `wp-import plans` re-checks these values against the
 * live posts. A plan's relist price equals its price (the legacy `_jr_relist_price`), and pack
 * credits never expire (no `creditExpiryDays`). `seedPlans` still refuses a `null`, so a guessed
 * value can never reach a database.
 */
/**
 * A listing runs for at most 45 days on Vanuatu Wok (founder, PJ-32): the employer's close date
 * is capped by the plan's duration, and the job expires at the end of that local day.
 */
export const VWOK_MAX_DURATION_DAYS = 45

export const vwokPlans: PlanSeed[] = [
  {
    durationDays: 30,
    jobCredits: 1,
    key: 'regular-listing',
    legacyId: 26,
    name: 'Regular listing',
    price: 3900,
    sortOrder: 10,
  },
  {
    durationDays: 30,
    jobCredits: 5,
    key: 'job-pack',
    legacyId: 28,
    name: '5 Job Pack',
    price: 17500,
    sortOrder: 20,
  },
  {
    durationDays: 30,
    jobCredits: 10,
    key: '10-job-pack',
    legacyId: 36082,
    name: '10 Job Pack',
    price: 33000,
    sortOrder: 30,
  },
  {
    durationDays: 30,
    // The Enhanced add-on for 30 days (`_jr_featured-listings_duration`).
    includedAddOns: [{ addOnKey: 'enhanced', durationDays: 30 }],
    jobCredits: 1,
    key: 'enhanced-listing',
    legacyId: 36084,
    name: 'Enhanced listing',
    price: 5900,
    sortOrder: 35,
  },
  {
    // Free, and only for voluntary jobs (USAGE.md): the Voluntary job type and its children are
    // flagged `isVolunteer` (PJ-16), which checkout passes to quote().
    acceptsCredits: false,
    durationDays: 30,
    isVolunteer: true,
    jobCredits: 1,
    key: 'volunteer-listing',
    legacyId: 31,
    name: 'Volunteer listing',
    price: 0,
    sortOrder: 40,
  },
]
