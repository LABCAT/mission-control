import type { AddOnSeed } from '@mission-control/payload-jobs'

/**
 * Vanuatu Wok's featured add-ons (AUDIT.md; founder decision 18 Nov 2026: both are kept).
 *
 * - Enhanced: featured in listings. Replaces the JobRoller job meta `_jr_featured-listings`.
 * - Premium: featured in its category. Replaces `_jr_featured-cat`. Buying Premium also gives
 *   30 days of Enhanced, as the old site did.
 *
 * Prices are VUV, which has no minor units, so 2000 is Vt 2,000. `null` = not confirmed yet:
 * the prices and durations come from the live JobRoller settings, and `seedAddOns` refuses to
 * run while any value is `null`, so a guessed price can never reach a database.
 */
export const vwokAddOns: AddOnSeed[] = [
  {
    durationDays: null,
    key: 'enhanced',
    legacyKey: '_jr_featured-listings',
    name: 'Enhanced',
    placement: 'featured-in-listings',
    price: null,
    sortOrder: 10,
  },
  {
    durationDays: null,
    grants: [{ addOnKey: 'enhanced', durationDays: 30 }],
    key: 'premium',
    legacyKey: '_jr_featured-cat',
    name: 'Premium',
    placement: 'featured-in-category',
    price: null,
    sortOrder: 20,
  },
]
