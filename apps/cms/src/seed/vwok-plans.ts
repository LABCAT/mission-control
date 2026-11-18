import type { PlanSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's live plans (USAGE.md, founder decision 18 Nov 2026): every live plan someone
 * buys is kept: Regular listing, Job pack, 10 Job pack, Volunteer listing and Enhanced listing.
 * "Unlimited 6 month" is not built. Enhanced listing is a plan that includes the Enhanced
 * add-on; the add-ons themselves (Enhanced, Premium) are seeded in PJ-87, and `seedPlans` defers
 * the plan until then.
 *
 * Prices are VUV, which has no minor units, so 5000 is Vt 5,000.
 *
 * `null` = not confirmed yet. The values come from the live `pricing-plan` posts (price,
 * duration, pack size, post ID) and must be copied in exactly. `seedPlans` refuses to run while
 * any value is `null`, so a guessed price can never reach a database.
 */
export const vwokPlans: PlanSeed[] = [
  {
    durationDays: null,
    jobCredits: 1,
    key: 'regular-listing',
    legacyId: null,
    name: 'Regular listing',
    price: null,
    sortOrder: 10,
  },
  {
    creditExpiryDays: null,
    durationDays: null,
    jobCredits: null,
    key: 'job-pack',
    legacyId: null,
    name: 'Job pack',
    price: null,
    sortOrder: 20,
  },
  {
    creditExpiryDays: null,
    durationDays: null,
    jobCredits: 10,
    key: '10-job-pack',
    legacyId: null,
    name: '10 Job pack',
    price: null,
    sortOrder: 30,
  },
  {
    durationDays: null,
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
    durationDays: null,
    isVolunteer: true,
    jobCredits: 1,
    key: 'volunteer-listing',
    legacyId: null,
    name: 'Volunteer listing',
    price: 0,
    sortOrder: 40,
  },
]
