/**
 * Collection slugs the admin knows about before their owning tasks land. Naming them here
 * keeps the site-manager menu and dashboard from being edited twice when orders (PJ-31) and
 * applications (PJ-22) arrive. Coupons and pages have landed, so their slugs come from the
 * collections themselves (`COUPONS_SLUG` in `src/coupons.ts`, `PAGES_SLUG` in
 * `src/collections/pages.ts`).
 */
export const ORDERS_SLUG = 'orders'
export const APPLICATIONS_SLUG = 'applications'
