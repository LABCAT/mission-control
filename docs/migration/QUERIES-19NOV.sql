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

-- 35. Do recent jobs have map coordinates? (proof before building a job map)
SELECT YEAR(p.post_date) y, COUNT(*) jobs,
  SUM(lat.meta_value IS NOT NULL AND lat.meta_value <> '') with_coords
FROM wp_posts p
LEFT JOIN wp_postmeta lat ON lat.post_id=p.ID AND lat.meta_key='_jr_geo_latitude'
WHERE p.post_type='job_listing' AND p.post_status IN ('publish','expired')
GROUP BY y ORDER BY y;

-- 36. Multiple locations per job: how are they stored? (sample of addresses with commas)
SELECT pm.meta_value address, COUNT(*) n FROM wp_postmeta pm JOIN wp_posts p ON p.ID=pm.post_id
WHERE p.post_type='job_listing' AND pm.meta_key='_jr_address' AND pm.meta_value LIKE '%,%'
GROUP BY pm.meta_value ORDER BY n DESC LIMIT 30;

-- ===== Feature inventory follow-ups (added 19 Nov, FEATURE-INVENTORY.md) =====
-- 37. Shortcodes / forms on published pages (no content, only the first shortcode name and length)
SELECT ID, post_type, post_name, REGEXP_SUBSTR(post_content,'\\[[A-Za-z0-9_-]+') first_shortcode,
  CHAR_LENGTH(post_content) len
FROM wp_posts WHERE post_type IN ('page','custom-form') AND post_status='publish' ORDER BY post_name;

-- 38. The rest of the jr_* options (only the first 100 rows were shown in query 6)
SELECT option_name, LEFT(option_value,120) value FROM wp_options
WHERE option_name LIKE 'jr\_%' AND option_name <> 'jr_options'
  AND option_name NOT REGEXP 'key|secret|token|password|api|email_body|_banner'
ORDER BY option_name;

-- 39. WP-cron hooks that are scheduled (run on the server; prints hook names only, no args)
-- mysql -N -e "SELECT option_value FROM wp_options WHERE option_name='cron'" <db> | grep -oE 's:[0-9]+:"[a-z0-9_]+";a:1' | sed -E 's/.*"(.*)".*/\1/' | sort | uniq -c

-- 40. Application attachments: are cover letters/CVs actually sent? (p2p meta keys, counts only)
SELECT pm.meta_key, COUNT(*) n FROM wp_p2pmeta pm GROUP BY pm.meta_key ORDER BY n DESC;

-- 41. Why jobs end: expiry/cancel reason values (first 40 chars, top 30)
SELECT meta_key, LEFT(meta_value,40) reason, COUNT(*) n FROM wp_postmeta
WHERE meta_key IN ('_jr_expired_reason','_jr_canceled_job')
GROUP BY meta_key, reason ORDER BY n DESC LIMIT 30;

-- 42. Pending and draft jobs by year and job type (does anything still wait for approval? are drafts recent?)
SELECT YEAR(p.post_date) y, p.post_status, COALESCE(t.slug,'(none)') job_type, COUNT(*) n
FROM wp_posts p
LEFT JOIN wp_term_relationships r ON r.object_id=p.ID
LEFT JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id=r.term_taxonomy_id AND tt.taxonomy='job_type'
LEFT JOIN wp_terms t ON t.term_id=tt.term_id
WHERE p.post_type='job_listing' AND p.post_status IN ('pending','draft') AND (tt.taxonomy='job_type' OR tt.taxonomy IS NULL)
GROUP BY y, p.post_status, job_type ORDER BY y DESC, n DESC;

-- 43. Employer contact fields filled in, among users who logged in since 2023, by role (counts only)
SELECT m.meta_key, CASE WHEN c.meta_value LIKE '%job_lister%' THEN 'lister' ELSE 'other' END role, COUNT(*) n
FROM wp_usermeta m
JOIN wp_usermeta l ON l.user_id=m.user_id AND l.meta_key='last_login' AND YEAR(l.meta_value)>=2023
JOIN wp_usermeta c ON c.user_id=m.user_id AND c.meta_key='wp_capabilities'
WHERE m.meta_key IN ('phone_number','job_title','physical_location','facebook','twitter','linkedin','instagram','youtube','wpseo_title','wpseo_metadesc')
  AND m.meta_value <> ''
GROUP BY m.meta_key, role ORDER BY m.meta_key;

-- 44. Resumes created per year and status (impact of dropping resumes, decision 1)
SELECT YEAR(post_date) y, post_status, COUNT(*) n FROM wp_posts
WHERE post_type='resume' GROUP BY y, post_status ORDER BY y DESC;

-- 45. Wordfence 2FA: how many users have it on? (count only)
SELECT COUNT(*) users_with_2fa FROM wp_wfls_2fa_secrets;

-- 46. What is the THANKSFROMYCV user meta? (values cut to 20 chars, counts)
SELECT LEFT(meta_value,20) v, COUNT(*) n FROM wp_usermeta WHERE meta_key='THANKSFROMYCV' GROUP BY v;

-- 47. Overseas / remote jobs (seed locations)
SELECT YEAR(p.post_date) y, COUNT(*) n FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id=p.ID AND pm.meta_key='_jr_address'
WHERE p.post_type='job_listing' AND (pm.meta_value LIKE '%overseas%' OR pm.meta_value LIKE '%anywhere%' OR pm.meta_value LIKE '%remote%' OR pm.meta_value LIKE '%home%')
GROUP BY y ORDER BY y DESC;

-- 48. Featured-in-category use in the last 24 months (confirms dropping it for vwok)
SELECT YEAR(p.post_date) y, COUNT(*) n FROM wp_posts p JOIN wp_postmeta pm ON pm.post_id=p.ID AND pm.meta_key='_jr_featured-cat' AND pm.meta_value<>''
WHERE p.post_type='job_listing' AND p.post_date >= NOW() - INTERVAL 24 MONTH GROUP BY y;

-- ===== Legacy code walk follow-ups (added 19 Nov, FEATURE-INVENTORY.md "Code walk: done") =====
-- 49. Page templates in use on published pages (finds the RSS feed pages, /confirm/, contact, organisations, home)
SELECT p.post_name, pm.meta_value template FROM wp_posts p
JOIN wp_postmeta pm ON pm.post_id=p.ID AND pm.meta_key='_wp_page_template'
WHERE p.post_type='page' AND p.post_status='publish' AND pm.meta_value NOT IN ('','default')
ORDER BY template, p.post_name;

-- 50. FXtender settings (which optional features are on). Keys/tokens and email addresses are masked; long text cut to 80 chars
SELECT option_name,
  CASE WHEN option_name REGEXP 'key|secret|token|api|password' THEN '[hidden]'
       WHEN option_value LIKE '%@%' THEN '[email]'
       ELSE LEFT(option_value,80) END value
FROM wp_options WHERE option_name LIKE 'jr\_fx\_%' ORDER BY option_name;

-- 51. Email template switches and subjects (Advanced Emails `_custom_*` and standalone `jr_nu_*`/`jr_new_ad_email`); no bodies, no addresses
SELECT option_name, LEFT(option_value,80) value FROM wp_options
WHERE (option_name LIKE '\_custom\_%' OR option_name IN ('jr_nu_custom_email','jr_nu_admin_email','jr_new_ad_email','jr_nu_email_type'))
  AND option_name NOT LIKE '%\_body' AND option_name NOT LIKE '%from\_email'
ORDER BY option_name;

-- 52. Category custom forms: the forms and their categories, then which custom fields jobs actually filled (keys + counts only)
SELECT p.ID, p.post_status, YEAR(p.post_date) y, GROUP_CONCAT(DISTINCT t.slug) categories
FROM wp_posts p
LEFT JOIN wp_term_relationships r ON r.object_id=p.ID
LEFT JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id=r.term_taxonomy_id AND tt.taxonomy='job_cat'
LEFT JOIN wp_terms t ON t.term_id=tt.term_id
WHERE p.post_type='custom-form' GROUP BY p.ID, p.post_status, y;
SELECT pm.meta_key, COUNT(*) n, MAX(p.post_date) last_used FROM wp_postmeta pm JOIN wp_posts p ON p.ID=pm.post_id
WHERE p.post_type='job_listing' AND pm.meta_key LIKE 'app\_%' AND pm.meta_value<>''
GROUP BY pm.meta_key ORDER BY n DESC;

-- 53. Jobs whose company name differs from the posting organisation's name (agency / "post for client" signal), by year; counts only
SELECT YEAR(p.post_date) y,
  SUM(c.meta_value = n.meta_value) same_as_org,
  SUM(c.meta_value <> n.meta_value) differs,
  COUNT(DISTINCT CASE WHEN c.meta_value <> n.meta_value THEN p.post_author END) orgs_with_differing_names
FROM wp_posts p
JOIN wp_postmeta c ON c.post_id=p.ID AND c.meta_key='_Company' AND c.meta_value<>''
JOIN wp_usermeta n ON n.user_id=p.post_author AND n.meta_key='nickname'
WHERE p.post_type='job_listing' AND p.post_status IN ('publish','expired')
GROUP BY y ORDER BY y DESC;

-- 54. Unconfirmed accounts (still holding a confirmation_key) by registration year: is email confirmation working?
SELECT YEAR(u.user_registered) y, COUNT(*) registered, SUM(k.user_id IS NOT NULL) unconfirmed
FROM wp_users u LEFT JOIN wp_usermeta k ON k.user_id=u.ID AND k.meta_key='confirmation_key'
GROUP BY y ORDER BY y DESC;

-- 55. Close dates employers choose (job duration in days) on jobs posted in the last 24 months
SELECT CASE WHEN CAST(d.meta_value AS UNSIGNED) >= 45 THEN '45+' WHEN CAST(d.meta_value AS UNSIGNED) >= 30 THEN '30-44'
            WHEN CAST(d.meta_value AS UNSIGNED) >= 14 THEN '14-29' ELSE '<14' END days, COUNT(*) n
FROM wp_posts p JOIN wp_postmeta d ON d.post_id=p.ID AND d.meta_key='_jr_job_duration'
WHERE p.post_type='job_listing' AND p.post_date >= NOW() - INTERVAL 24 MONTH
GROUP BY days ORDER BY days;

-- 56. Selected keys inside the serialised jr_options array (bool vs 'yes' matters for the theme's `== 'yes'` tests)
SELECT k.name, REGEXP_SUBSTR(o.option_value, CONCAT('"', k.name, '";[^;]*;')) value
FROM wp_options o
JOIN (SELECT 'jr_ad_stats_all' name UNION ALL SELECT 'apply_reg_users_only' UNION ALL SELECT 'allow_job_comments'
      UNION ALL SELECT 'plan_type' UNION ALL SELECT 'include_nowhere' UNION ALL SELECT 'jr_submit_how_to_apply_display'
      UNION ALL SELECT 'jr_nu_admin_email' UNION ALL SELECT 'jr_new_ad_email' UNION ALL SELECT 'jr_nu_custom_email') k
WHERE o.option_name='jr_options';

-- 57. Are resumes actually viewed? Resume page views are recorded only for viewers who can open them
--     (employers/admins; the author's own views are excluded). Counts only, no personal data.
SELECT YEAR(p.post_date) created, p.post_status, COUNT(*) resumes,
  SUM(COALESCE(t.postcount,0) > 0) viewed_at_least_once,
  SUM(COALESCE(t.postcount,0)) total_views,
  MAX(COALESCE(t.postcount,0)) max_views
FROM wp_posts p LEFT JOIN wp_jr_counter_total t ON t.postnum = p.ID
WHERE p.post_type='resume' GROUP BY created, p.post_status ORDER BY created;
-- 58. Recent daily resume views (if the daily table keeps history): views per month
SELECT DATE_FORMAT(d.time,'%Y-%m') m, SUM(d.postcount) views, COUNT(DISTINCT d.postnum) resumes
FROM wp_jr_counter_daily d JOIN wp_posts p ON p.ID=d.postnum AND p.post_type='resume'
GROUP BY m ORDER BY m DESC LIMIT 24;

-- 59. Do admins post jobs for other organisations? Jobs authored by administrator/editor accounts, by year (counts only)
SELECT YEAR(p.post_date) y, COUNT(*) jobs
FROM wp_posts p JOIN wp_usermeta m ON m.user_id=p.post_author AND m.meta_key='wp_capabilities'
WHERE p.post_type='job_listing' AND p.post_status IN ('publish','expired')
  AND (m.meta_value LIKE '%"administrator"%' OR m.meta_value LIKE '%"editor"%')
GROUP BY y ORDER BY y;

-- 60. Job packs: bought on their own, or while posting a job? (counts only, no personal data)
--     Orders (post_type 'transaction') linked through wp_p2p to a pack plan (28 = 5 Job Pack, 36082 = 10 Job Pack),
--     split by whether the same order is also linked to a job_listing. By year and order status.
SELECT YEAR(o.post_date) y, o.post_status,
  CASE WHEN EXISTS (
    SELECT 1 FROM wp_p2p x2 JOIN wp_posts j ON j.ID IN (x2.p2p_from, x2.p2p_to) AND j.post_type='job_listing'
    WHERE o.ID IN (x2.p2p_from, x2.p2p_to)) THEN 'with job' ELSE 'pack only' END AS bought,
  COUNT(DISTINCT o.ID) orders
FROM wp_posts o
JOIN wp_p2p x ON o.ID IN (x.p2p_from, x.p2p_to)
JOIN wp_posts pk ON pk.ID IN (x.p2p_from, x.p2p_to) AND pk.ID IN (28, 36082)
WHERE o.post_type = 'transaction'
GROUP BY y, o.post_status, bought ORDER BY y DESC, bought;
-- 60b. If 60 returns nothing (orders link packs another way): which p2p types touch the pack plans? (counts only)
SELECT x.p2p_type, COUNT(*) n FROM wp_p2p x WHERE x.p2p_from IN (28, 36082) OR x.p2p_to IN (28, 36082) GROUP BY x.p2p_type;
