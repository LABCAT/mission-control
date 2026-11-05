-- vanuatuwok.vu – feature usage queries (READ ONLY)
-- Run against the live DB (or a fresh copy). Assumes the default prefix `wp_`.
-- Purpose: decide which features from AUDIT.md are actually used, so we only rebuild those.
-- Window: last 24 months unless noted. Adjust @since if needed.

SET @since = DATE_SUB(NOW(), INTERVAL 24 MONTH);

-- 1. Users by role (all time) and new registrations by role since @since
SELECT um.meta_value AS role, COUNT(*) AS users,
       SUM(u.user_registered >= @since) AS new_since
FROM wp_usermeta um JOIN wp_users u ON u.ID = um.user_id
WHERE um.meta_key = 'wp_capabilities'
GROUP BY um.meta_value ORDER BY users DESC;

-- 2. Jobs posted per month, by status
SELECT DATE_FORMAT(post_date, '%Y-%m') AS month, post_status, COUNT(*) AS jobs
FROM wp_posts
WHERE post_type = 'job_listing' AND post_date >= @since
GROUP BY month, post_status ORDER BY month;

-- 3. Jobs since @since by job type (shows paid vs Voluntary split)
SELECT t.name AS job_type, COUNT(*) AS jobs
FROM wp_posts p
JOIN wp_term_relationships tr ON tr.object_id = p.ID
JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'job_type'
JOIN wp_terms t ON t.term_id = tt.term_id
WHERE p.post_type = 'job_listing' AND p.post_date >= @since
GROUP BY t.name ORDER BY jobs DESC;

-- 4. Orders since @since by gateway and status, with revenue
SELECT COALESCE(g.meta_value, '(none)') AS gateway, p.post_status, COUNT(*) AS orders,
       SUM(CAST(tp.meta_value AS DECIMAL(12,2))) AS total
FROM wp_posts p
LEFT JOIN wp_postmeta g  ON g.post_id = p.ID AND g.meta_key = 'gateway'
LEFT JOIN wp_postmeta tp ON tp.post_id = p.ID AND tp.meta_key = 'total_price'
WHERE p.post_type = 'transaction' AND p.post_date >= @since
GROUP BY gateway, p.post_status ORDER BY orders DESC;

-- 5. Orders per month (is anyone paying at all?)
SELECT DATE_FORMAT(p.post_date, '%Y-%m') AS month, COUNT(*) AS orders,
       SUM(CAST(tp.meta_value AS DECIMAL(12,2))) AS total
FROM wp_posts p
LEFT JOIN wp_postmeta tp ON tp.post_id = p.ID AND tp.meta_key = 'total_price'
WHERE p.post_type = 'transaction' AND p.post_date >= @since
GROUP BY month ORDER BY month;

-- 6. Featured add-ons on jobs since @since
SELECT pm.meta_key, COUNT(DISTINCT p.ID) AS jobs
FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id = p.ID
WHERE p.post_type = 'job_listing' AND p.post_date >= @since
  AND pm.meta_key IN ('_jr_featured-listings', '_jr_featured-cat')
  AND pm.meta_value NOT IN ('', '0')
GROUP BY pm.meta_key;

-- 7. Pricing plans (job + resume) and their status
SELECT post_type, post_status, ID, post_title
FROM wp_posts WHERE post_type IN ('pricing-plan', 'resumes-pricing-plan')
ORDER BY post_type, post_status;

-- 8. Coupons and how often each has been used (all time)
SELECT p.post_title, p.post_status, c.meta_value AS code, u.meta_value AS use_count, p.post_modified
FROM wp_posts p
LEFT JOIN wp_postmeta c ON c.post_id = p.ID AND c.meta_key = 'code'
LEFT JOIN wp_postmeta u ON u.post_id = p.ID AND u.meta_key = 'use_count'
WHERE p.post_type = 'discount_coupon' ORDER BY p.post_modified DESC;

-- 9. Job packs held by users (all time)
SELECT COUNT(DISTINCT user_id) AS users_with_packs, COUNT(*) AS packs
FROM wp_usermeta WHERE meta_key LIKE '\_jr\_user\_pack-%';

-- 10. Resumes created per year, and resume-access usage
SELECT YEAR(post_date) AS yr, post_status, COUNT(*) AS resumes
FROM wp_posts WHERE post_type = 'resume' GROUP BY yr, post_status ORDER BY yr;

SELECT meta_key, COUNT(DISTINCT user_id) AS users
FROM wp_usermeta
WHERE meta_key IN ('_valid_resume_trial', '_jr_fx_resume_views', '_jr_fx_resume_views_left', '_jr_fx_resume_views_hist')
GROUP BY meta_key;

-- 11. Job applications (Posts 2 Posts) by connection type (all time)
SELECT p2p_type, COUNT(*) AS connections FROM wp_p2p GROUP BY p2p_type;

-- 12. Job alert subscribers
SELECT meta_value AS alert_status, COUNT(*) AS users
FROM wp_usermeta WHERE meta_key = 'jr_alert_status' GROUP BY meta_value;

-- 13. Job alert runs logged since @since
SELECT DATE_FORMAT(post_date, '%Y-%m') AS month, COUNT(*) AS runs
FROM wp_posts WHERE post_type = 'job-alerts-log' AND post_date >= @since
GROUP BY month ORDER BY month;

-- 14. Organisation pages
SELECT meta_key, meta_value, COUNT(*) AS users
FROM wp_usermeta
WHERE meta_key IN ('enable_organisations_page', 'listing_request', 'can_pay_by_bank_transfer')
GROUP BY meta_key, meta_value;

-- 15. Jobs with a PDF job description attached since @since
SELECT COUNT(DISTINCT a.post_parent) AS jobs_with_pdf
FROM wp_posts a JOIN wp_posts j ON j.ID = a.post_parent
WHERE a.post_type = 'attachment' AND a.post_mime_type = 'application/pdf'
  AND j.post_type = 'job_listing' AND j.post_date >= @since;

-- 16. Xero activity (order-log entries) per month since @since
SELECT DATE_FORMAT(post_date, '%Y-%m') AS month, COUNT(*) AS log_entries
FROM wp_posts WHERE post_type = 'order-log' AND post_date >= @since
GROUP BY month ORDER BY month;

-- 17. Blog posts and pages (content volume)
SELECT post_type, post_status, COUNT(*) AS n, MAX(post_date) AS latest
FROM wp_posts WHERE post_type IN ('post', 'page') GROUP BY post_type, post_status;

-- 18. Which cron hooks are actually scheduled right now
SELECT option_value FROM wp_options WHERE option_name = 'cron';

-- 19. Active plugins and enabled payment gateways (look for gateway settings in the output)
SELECT option_name, LEFT(option_value, 2000) AS value
FROM wp_options
WHERE option_name IN ('active_plugins', 'jr_options')
   OR option_name LIKE 'jr\_%gateway%' OR option_name LIKE 'jr\_enable\_%';
