import type { ImportPlan } from '../importers/users'

export const COMMERCE_NOW = new Date('2026-11-20T00:00:00Z')

let metaId = 0
const pm = (post_id: number, meta_key: string, meta_value: string) => ({ meta_id: ++metaId, meta_key, meta_value, post_id })
let usermetaId = 0
const um = (user_id: number, meta_key: string, meta_value: string) => ({ meta_key, meta_value, umeta_id: ++usermetaId, user_id })
const post = (ID: number, post_type: string, post_status: string, extra: Record<string, unknown> = {}) => ({
  ID,
  post_author: 7,
  post_date: '2026-10-15 09:00:00',
  post_date_gmt: '2026-10-14 22:00:00',
  post_modified_gmt: '2026-10-16 01:00:00',
  post_status,
  post_title: `Post ${ID}`,
  post_type,
  ...extra,
})
const p2p = (id: number, from: number, to: number) => ({ p2p_from: from, p2p_id: id, p2p_to: to, p2p_type: 'order-connection' })

export const commerceTables = {
  wp_p2p: [
    p2p(1, 5001, 1001), p2p(2, 5001, 26), p2p(3, 5002, 1002), p2p(4, 5002, 36084), p2p(5, 5008, 28),
    { p2p_from: 5001, p2p_id: 6, p2p_to: 9999, p2p_type: 'jr_job_application' },
  ],
  wp_postmeta: [
    // Plans
    pm(26, '_jr_price', '3900'), pm(26, '_jr_relist_price', '3900'), pm(26, '_jr_duration', '30'), pm(26, '_jr_jobs_limit', '1'),
    pm(28, '_jr_price', '17500'), pm(28, '_jr_relist_price', '17500'), pm(28, '_jr_duration', '30'), pm(28, '_jr_jobs_limit', '5'),
    pm(36084, '_jr_price', '5900'), pm(36084, '_jr_relist_price', '5900'), pm(36084, '_jr_duration', '30'), pm(36084, '_jr_jobs_limit', '1'),
    // Coupons
    pm(297, 'code', 'WIKFREE'), pm(297, 'type', 'flat'), pm(297, 'amount', '4000'), pm(297, 'end_date', '01/02/2025'), pm(297, 'use_count', '2'), pm(297, 'use_limit', '0'),
    pm(38641, 'code', 'LINKPS'), pm(38641, 'type', 'flat'), pm(38641, 'amount', '1900'), pm(38641, 'end_date', ''), pm(38641, 'use_count', '501'), pm(38641, 'use_limit', '0'),
    pm(300, 'code', 'spring25'), pm(300, 'type', 'percent'), pm(300, 'amount', '25'), pm(300, 'end_date', '12/31/2026'), pm(300, 'use_count', '3'), pm(300, 'use_limit', '10'),
    // Orders
    pm(5001, 'total_price', '3900'), pm(5001, '_xero_invoice_id', 'inv-0001'), pm(5001, 'tax_charge', '0'),
    pm(5002, 'total_price', '5900'), pm(5002, '_xero_invoice_id', 'inv-0002'),
    pm(5003, 'total_price', '3900'),
    pm(5004, 'total_price', '3900'),
    pm(5005, 'total_price', '3900'),
    pm(5007, 'total_price', '0'),
    pm(5008, 'total_price', '17500'),
    pm(5009, 'total_price', '3900'), pm(5009, 'tax_charge', '585'),
    pm(5010, 'total_price', '3900'),
  ],
  wp_posts: [
    post(26, 'pricing-plan', 'publish'), post(28, 'pricing-plan', 'publish'), post(36084, 'pricing-plan', 'publish'),
    post(4000, 'pricing-plan', 'pending'),
    post(297, 'discount_coupon', 'publish'), post(38641, 'discount_coupon', 'publish'), post(300, 'discount_coupon', 'publish'),
    post(5001, 'transaction', 'tr_pending', { post_date: '2026-10-15 09:00:00' }),
    post(5002, 'transaction', 'tr_activated', { post_date: '2026-09-02 09:00:00', post_date_gmt: '2026-09-01 22:00:00', post_modified_gmt: '2026-09-05 00:00:00' }),
    post(5003, 'transaction', 'tr_failed', { post_date: '2026-08-03 09:00:00', post_date_gmt: '2026-08-02 22:00:00' }),
    post(5004, 'transaction', 'tr_pending', { post_date: '2024-10-31 09:00:00', post_date_gmt: '2024-10-30 22:00:00' }),
    post(5005, 'transaction', 'tr_refunded'),
    post(5006, 'transaction', 'tr_pending'),
    post(5007, 'transaction', 'tr_completed', { post_date: '2026-10-20 09:00:00', post_date_gmt: '2026-10-19 22:00:00' }),
    post(5008, 'transaction', 'tr_pending', { post_date: '2026-10-21 09:00:00', post_date_gmt: '2026-10-20 22:00:00' }),
    post(5009, 'transaction', 'tr_pending'),
    post(5010, 'transaction', 'tr_pending', { post_author: 99, post_date: '2026-11-02 09:00:00', post_date_gmt: '2026-11-01 22:00:00' }),
  ],
  wp_usermeta: [
    um(7, '_jr_user_pack-28-5008', '3'),
    um(8, '_jr_user_pack-36082-4000', 'a:2:{s:10:"jobs_limit";i:10;s:10:"jobs_count";i:4;}'),
    um(8, '_jr_user_pack-28-4001', '0'),
    um(9, '_jr_user_pack-28-4002', 'a:1:{s:3:"foo";i:1;}'),
    um(99, '_jr_user_pack-28-4003', '2'),
    um(7, '_jr_user_packs_active', 'a:1:{i:0;s:21:"_jr_user_pack-28-5008";}'),
    um(7, 'nickname', 'Example Resort Ltd'),
  ],
}

// Users 7 and 8 belong to organisations 70 and 80 (the users import decided that).
export const commerceUsersPlan = {
  groups: [],
  organisationOf: new Map([
    [7, { organisationLegacyId: 7, owner: true }],
    [8, { organisationLegacyId: 8, owner: true }],
    [9, { organisationLegacyId: 7, owner: false }],
  ]),
  report: { employersKept: 3, organisations: 2, organisationsMerged: 1, usersKept: 3, usersRead: 3 },
  users: new Map(),
} as unknown as ImportPlan

