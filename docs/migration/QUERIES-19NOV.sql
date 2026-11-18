-- Read-only queries for the founder to run on the vwok WordPress DB (19 Nov).
-- Paste the output back to the sprint orchestrator.

-- 1. Live pricing plans and their settings (PJ-21 seed)
SELECT p.ID, p.post_title, p.post_status, pm.meta_key, pm.meta_value
FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id = p.ID
WHERE p.post_type = 'pricing-plan' AND p.post_status = 'publish'
ORDER BY p.ID, pm.meta_key;

-- 2. Privacy policy / terms pages (PJ-89)
SELECT ID, post_title, post_name, post_status, post_modified
FROM wp_posts
WHERE post_type = 'page'
  AND (post_title LIKE '%privacy%' OR post_title LIKE '%terms%' OR post_title LIKE '%policy%'
       OR post_name LIKE '%privacy%' OR post_name LIKE '%terms%');
SELECT option_name, option_value FROM wp_options WHERE option_name = 'wp_page_for_privacy_policy';

-- 3. Expired jobs: shown with a notice, or hidden? (decision 17 context)
SELECT option_name, LEFT(option_value, 300) AS value FROM wp_options
WHERE option_name LIKE '%jr_options%' OR option_name LIKE '%expired%' LIMIT 20;

-- 4. Users by last login year (PJ-62: which users to migrate)
SELECT COALESCE(YEAR(um.meta_value), 'never') AS last_login_year, COUNT(*) AS users
FROM wp_users u
LEFT JOIN wp_usermeta um ON um.user_id = u.ID AND um.meta_key = 'last_login'
GROUP BY last_login_year ORDER BY last_login_year DESC;

-- 5. Coupons: settings, and how often each was used in the last 12 months (LINKPS decision)
SELECT c.ID, c.post_title AS code, c.post_status, pm.meta_key, pm.meta_value
FROM wp_posts c JOIN wp_postmeta pm ON pm.post_id = c.ID
WHERE c.post_type = 'discount_coupon' ORDER BY c.ID, pm.meta_key;
SELECT c.post_title AS code, COUNT(*) AS orders_last_12mo, MAX(o.post_date) AS last_used
FROM wp_p2p x
JOIN wp_posts c ON c.ID IN (x.p2p_from, x.p2p_to) AND c.post_type = 'discount_coupon'
JOIN wp_posts o ON o.ID IN (x.p2p_from, x.p2p_to) AND o.ID <> c.ID
WHERE o.post_date >= NOW() - INTERVAL 12 MONTH
GROUP BY c.post_title;

-- 6. Tax / VAT settings in the old site (PJ-91): JobRoller and Xero plugin options mentioning tax or VAT
SELECT option_name, LEFT(option_value, 400) AS value FROM wp_options
WHERE (option_name LIKE '%tax%' OR option_name LIKE '%vat%' OR option_name LIKE '%xero%' OR option_name LIKE 'jr_%')
  -- never print credentials:
  AND option_name NOT LIKE '%token%' AND option_name NOT LIKE '%secret%' AND option_name NOT LIKE '%key%'
  AND option_name NOT LIKE '%password%' AND option_name NOT LIKE '%auth%' AND option_name NOT LIKE '%credential%';
-- Before pasting the output anywhere, scan it for anything that looks like a key or token and remove it.
