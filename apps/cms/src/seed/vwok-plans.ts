import type { PlanSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's live plans (USAGE.md, founder decision 18 Nov 2026): every live plan someone
 * buys is kept: Regular listing, Job pack, 10 Job pack, Volunteer listing and Enhanced listing.
 * "Unlimited 6 month" is not built. Enhanced listing is a plan that includes the Enhanced
 * add-on (seeded from `vwok-add-ons.ts`, before the plans).
 *
 * Prices are VUV, which has no minor units, so 5000 is Vt 5,000.
 *
 * `null` = not confirmed yet. The values come from the live `pricing-plan` posts (price,
 * duration, pack size, post ID) and must be copied in exactly. `seedPlans` refuses to run while
 * any value is `null`, so a guessed price can never reach a database.
 */
/**
 * A listing runs for at most 45 days on Vanuatu Wok (founder, PJ-32): the employer's close date
 * is capped by the plan's duration, and the job expires at the end of that local day.
 */
export const VWOK_MAX_DURATION_DAYS = 45

export const vwokPlans: PlanSeed[] = [
  {
    durationDays: VWOK_MAX_DURATION_DAYS,
    jobCredits: 1,
    key: 'regular-listing',
    legacyId: null,
    name: 'Regular listing',
    price: null,
    sortOrder: 10,
  },
  {
    creditExpiryDays: null,
    durationDays: VWOK_MAX_DURATION_DAYS,
    jobCredits: null,
    key: 'job-pack',
    legacyId: null,
    name: 'Job pack',
    price: null,
    sortOrder: 20,
  },
  {
    creditExpiryDays: null,
    durationDays: VWOK_MAX_DURATION_DAYS,
    jobCredits: 10,
    key: '10-job-pack',
    legacyId: null,
    name: '10 Job pack',
    price: null,
    sortOrder: 30,
  },
  {
    durationDays: VWOK_MAX_DURATION_DAYS,
    // The Enhanced add-on for the listing's duration, unless the live plan says otherwise.
    includedAddOns: [{ addOnKey: 'enhanced', durationDays: null }],
    jobCredits: 1,
    key: 'enhanced-listing',
    legacyId: null,
    name: 'Enhanced listing',
    price: null,
    sortOrder: 35,
  },
  {
    // Free, and only for voluntary jobs (USAGE.md): the Voluntary job type and its children are
    // flagged `isVolunteer` (PJ-16), which checkout passes to quote().
    acceptsCredits: false,
    durationDays: VWOK_MAX_DURATION_DAYS,
    isVolunteer: true,
    jobCredits: 1,
    key: 'volunteer-listing',
    legacyId: null,
    name: 'Volunteer listing',
    price: 0,
    sortOrder: 40,
  },
]
