/**
 * Collection slugs the admin knows about before their owning tasks land. Naming them here
 * keeps the site-manager menu and dashboard from being edited twice when orders (PJ-31),
 * applications (PJ-22) and pages arrive. Coupons have landed, so their slug is the
 * collection's own (`COUPONS_SLUG` in `src/coupons.ts`).
 */
export const ORDERS_SLUG = 'orders'
export const APPLICATIONS_SLUG = 'applications'
export const PAGES_SLUG = 'pages'
