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

-- 7. Is the legacy contact form page in use? (any row with post_status 'publish' = yes)
SELECT p.ID, p.post_title, p.post_name, p.post_status
FROM wp_posts p JOIN wp_postmeta m ON m.post_id = p.ID
WHERE m.meta_key = '_wp_page_template' AND m.meta_value = 'tpl-contact.php';

-- ===== Import scope (added 19 Nov) =====
-- 8. What content exists: counts per post type and status
SELECT post_type, post_status, COUNT(*) n, MAX(post_date) latest
FROM wp_posts GROUP BY post_type, post_status ORDER BY post_type, n DESC;

-- 9. Blog posts and pages: are they current? (titles only)
SELECT ID, post_type, post_title, post_name, post_status, post_date
FROM wp_posts WHERE post_type IN ('post','page') AND post_status = 'publish'
ORDER BY post_type, post_date DESC;

-- 10. Taxonomies in use (incl. job_tag, job_salary, area-of-focus)
SELECT tt.taxonomy, COUNT(*) terms, SUM(tt.count) uses
FROM wp_term_taxonomy tt GROUP BY tt.taxonomy ORDER BY uses DESC;

-- 11. Menus (header/footer/mobile) and their items
SELECT t.name menu, p.post_title, pm.meta_value item_type
FROM wp_terms t JOIN wp_term_taxonomy tt ON tt.term_id=t.term_id AND tt.taxonomy='nav_menu'
JOIN wp_term_relationships r ON r.term_taxonomy_id=tt.term_taxonomy_id
JOIN wp_posts p ON p.ID=r.object_id
LEFT JOIN wp_postmeta pm ON pm.post_id=p.ID AND pm.meta_key='_menu_item_object'
ORDER BY t.name, p.menu_order;

-- 12. Organisation/user meta keys in use (keys + counts only, no values)
SELECT meta_key, COUNT(*) n FROM wp_usermeta
WHERE meta_key NOT LIKE '%session%' AND meta_key NOT LIKE '%capabilities%'
GROUP BY meta_key ORDER BY n DESC;

-- 13. Job meta keys in use (keys + counts only)
SELECT pm.meta_key, COUNT(*) n FROM wp_postmeta pm JOIN wp_posts p ON p.ID=pm.post_id
WHERE p.post_type='job_listing' GROUP BY pm.meta_key ORDER BY n DESC;

-- 14. Job view counters: do they exist and are they recent?
SELECT COUNT(*) jobs_with_views, SUM(postcount) total_views FROM wp_jr_counter_total;

-- 15. Invoice-me customers (bank transfer allowed) and org page states
SELECT meta_key, meta_value, COUNT(*) n FROM wp_usermeta
WHERE meta_key IN ('can_pay_by_bank_transfer','enable_organisations_page','listing_request')
GROUP BY meta_key, meta_value;

-- 16. Comments (are any in use?)
SELECT comment_type, comment_approved, COUNT(*) n FROM wp_comments GROUP BY comment_type, comment_approved;

-- 17. Email providers used (domain only, top 25) — decides Google/Microsoft login
SELECT LOWER(SUBSTRING_INDEX(user_email,'@',-1)) domain, COUNT(*) n
FROM wp_users GROUP BY domain ORDER BY n DESC LIMIT 25;
