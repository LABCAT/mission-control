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
