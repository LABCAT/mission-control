import type { PlanSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's live plans (USAGE.md, founder decision 18 Nov 2026): Regular listing, Job pack,
 * 10 Job pack and Volunteer listing. "Unlimited 6 month" is not built. Enhanced and Premium are
 * add-ons (PJ-87), not plans.
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
    // Free: volunteer posting stays free (USAGE.md). TODO(PJ-16 follow-up): restrict this plan
    // to the Voluntary job type once taxonomies are on main.
    acceptsCredits: false,
    durationDays: null,
    jobCredits: 1,
    key: 'volunteer-listing',
    legacyId: null,
    name: 'Volunteer listing',
    price: 0,
    sortOrder: 40,
  },
]
