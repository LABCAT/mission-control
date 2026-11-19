# vanuatuwok.vu – feature inventory vs new-site decisions (19 Nov 2026)

Every behaviour of the live WordPress/JobRoller site that we could find evidence for, checked against the binding decisions (`STATUS.md` "Decision …" lines, where the later one wins), `PROPOSAL-ROLES.md`, `TICKET-CLEANUP-19NOV.md` and the D1 `PJ-*` tickets.

**Status values:** COVERED (a decision or ticket is cited) · DROPPED (a decision drops it) · OFF/UNUSED (a setting or data shows it isn't used) · GAP (no decision yet; a proposed default is given).

**Proposed defaults follow the founder's principles.** Legacy parity by default. Every business rule is a per-tenant setting that defaults to vwok's current behaviour. Simplest option. No deprecated legacy logic. Low cost. PageSpeed 100.

## Code walk: done (19 Nov, second pass)

The legacy repo `LABCAT/vanuatuwok.vu` was walked file by file: the live child theme `efate` (PHP templates, `includes/`, and the `_dev/js` + `_dev/scss` sources, not the minified builds), the parts of the parent `jobroller` theme that efate calls or overrides (JobRoller loads a child-theme copy of any `includes/*.php` first, `jr/framework/kernel/functions.php:169-181`, so efate's `includes/forms.php`, `template-tags.php` and `geolocation.php` replace the parent's), and the custom plugins `appthemes-advanced-emails`, `appthemes-coupons`, `appthemes-xero-invoices`, `fxtender-pro`, `jobroller-extensions`, `wp-job-alerts`, `wp-job-reports`, `wp-organisations` and `wp-site-logs`. `registration-honeypot`, `user-switching` and `multi-image-metabox` are installed by Composer (wpackagist) and are not in the repo; only their use by the theme was checked. The [code] tags are gone: each row now cites `file:line`. FXtender's behaviour depends on `jr_fx_*` options that no query has read yet (query 50), and a few email switches are read with `get_option(...) == 'yes'` (query 51). Queries 49–56 settle what only the DB can show.

Paths are relative to `web/app/`. Abbreviations: `efate/` = themes/efate, `jr/` = themes/jobroller, `jre/` = plugins/jobroller-extensions, `fx/` = plugins/fxtender-pro, `aae/` = plugins/appthemes-advanced-emails, `axi/` = plugins/appthemes-xero-invoices, `wja/` = plugins/wp-job-alerts, `wpo/` = plugins/wp-organisations, `wpsl/` = plugins/wp-site-logs, `wpjr/` = plugins/wp-job-reports, `cpn/` = plugins/appthemes-coupons.

| Source | Abbrev. |
|---|---|
| Legacy code, `LABCAT/vanuatuwok.vu` @ `ef1b5ae` | `file:line` |
| `AUDIT.md`: the Oct 2026 code audit of the same legacy repo | AUDIT |
| `QUERY-RESULTS-19NOV.md`: live DB and `jr_options`, section n | QR§n |
| `USAGE.md`: live usage, 22 Oct | USAGE |
| `docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md`: public crawl, section n | CRAWL§n |
| `STATUS.md` decision lines | "Decision: …" |
| D1 ticket prompts | PJ-nn |

**What the code walk changed** (details in the rows): the job page's footer bar (Apply button, Star job, Print, View map, Edit) is hidden with `style="display:none"` (`efate/single-job_listing.php:176`), so no map, print or star link is visible on the live site; the "Multiple Locations?" checkbox only swaps the Island/Town picker for a free-text address; radius search is not in the UI and location search is a text match; the admin copy of new registrations is off; the admin "new job" email is on; the expiry "reason" is a system code, not something the employer picks; legacy never stores CVs (they are emailed, then deleted); the free-text salary and the per-job company website have no public input or display.

---

## GAPS needing the founder (most important first)

1. **"Order paid": no defined trigger.** Legacy: a site manager presses Activate/Complete on the order screen (`jr/includes/payments/admin/order-single.php:272-278`); 'trusted' (invoice-me) orgs publish at submit (`jre/includes/class-jre-job-submission-process.php:283-305`); bank-transfer orders never auto-complete (`ACTIVATE_INVOICES` undefined, `:234-243`). *Default: a site manager marks the order paid in the admin (sends "order paid", releases the job). Xero payment sync is post-MVP.*
2. **Multiple locations per job.** The checkbox swaps the picker for a free-text address (`efate/_dev/js/modules/location-selector-functions.js:57-70`); the job stores one string. *Default: job → locations has-many (multi-select in the PJ-99 picker); import splits legacy text on ", " and " and " and matches location names, the rest goes to "Other". Query 36.*
3. **CV/resume module still public** (201 public + 325 private resumes, `/resumes/*`, 176 CV taxonomy URLs, `/resumes/feed/`). *Default: `/resumes/*` → 410, not in the redirect map; resumes and `uploaded_cvs` not imported, destroyed with the server (data deletion = founder).*
4. **Per-job company name (`_Company`).** Free text on every job, cleared on each new posting (`efate/_dev/js/modules/job-submit-form.js:12-16`), shown instead of the org name; the org link appears only when it equals the org name (`jre/includes/jre-frontend-functions.php:46-70`). *Default: orgs post as themselves; agencies use their Clients list (Decision: agencies); import `_Company` as the client name where it differs from the org name. Query 53.*
5. **Site manager posts a job for an organisation.** Legacy admins post jobs and pick the Xero contact at the plan step (`axi/includes/class-axi-invoice-manager.php:325-359`). *Default: site managers create and edit jobs for any org in the admin; the invoice goes to that org.*
6. **Expiry reminder timing.** Legacy sends two reminders, 5 days and 1 day before close (`jr/includes/job-status.php:56-59`); the email-list decision says "expiring in 3 days". *Default: per-tenant reminder days, vwok [5, 1] (parity); PJ-52 keeps "at most once per reminder".*
7. **Public view counter on job pages** ("N views, M today", `efate/single-job_listing.php:149`, shown when `jr_ad_stats_all` is 'yes'/true). *Default: off (cached HTML can't show live counts); employers see views in /account (PJ-110). Per-tenant setting. Query 56 confirms the stored value.*
8. **Category custom form fields** (JobRoller form builder, `custom-form` post from 2018; extra fields per category, shown on the job page, `efate/includes/template-tags.php:317-345`). *Default: not built; if query 52 shows jobs using them, append the values to the description at import.*
9. **"Log in as user"** (User Switching plugin, no custom use). *Default: none in the MVP; site managers edit on the user's behalf in the admin.*
10. **Legacy search query URLs** (`/jobs/?s=`, `?location=`, `?{type}=show&action=Filter`, `?time=week&jobs_by_date=1`, `?radius=`). *Default: 301 each to the new filter URL (PJ-42 table); unknown params dropped per the junk-URL rule.*
11. **WP attachment pages and `?p=` shortlinks** (147 / 50). *Default: attachment page → 301 to the imported R2 file, else 410; `?p=ID` → 301 to the new URL (PJ-42).*
12. **Overseas / remote jobs** (picker entries "Overseas", "Other", "Anywhere/Work From Home", `efate/_dev/js/modules/regions-and-towns.js:39-46`; empty location shows "Anywhere", `efate/loop-job.php:33-43`). *Default: seed "Overseas", "Remote / anywhere" and "Other" as top-level locations.*
13. **Promo texts around posting.** `jr_jobs_submit_text` ("from Vt 4,000", cheapest plan is 3,900) shows in the sidebar "Submit a job" box (`efate/sidebar-sjob.php:9`); `boosted_listing_text` shows under the add-on checkboxes (`jre/includes/admin/class-jre-admin-jobroller-enhancements.php:92-110`). *Default: one rich-text intro on the plan step (site settings); prices come from the Plans block, never typed.*
14. **Legacy pages of unknown purpose:** "Sign-up to our Email", "Application form", "Job email text", the paid/voluntary jobs feed pages (`efate/feeds/*.php`, the home page links `/rss-feed/`, `efate/vantage-home-page.php:166`). *Default: not imported; /sign-up → alert sign-up; feeds wait for PJ-116. Queries 37, 49.*
15. **Category required and editable after posting** (`jr_submit_cat_required = 1`, `jr_submit_cat_editable = 1`, `efate/includes/forms/submit-job/submit-job-form.php:71-99`). *Default: parity, per-tenant settings in PJ-82.*
16. **Volunteer "job approved" email** is a separate template (`_custom_volunteer_job_approved_email`, `aae/includes/class-aae-email-controller.php:88-107`). *Default: one "job live" template with a job-type variable and a conditional line.*
17. **Organisation SEO fields** (Yoast `wpseo_title`/`wpseo_metadesc` on 88 org users). *Default: import into the org SEO tab (PJ-62/104).*
18. **Employer contact fields** (phone = area code + number, physical location, contact job title, `efate/tpl-profile.php:54,263-266`; phone and location shown on the org page, `efate/author.php:6-16,85-87,126`). *Default: phone and location on the organisation (PJ-18); contact job title dropped. Query 43.*
19. **Volunteer default salary.** Choosing Voluntary / Micro-volunteer / Board position auto-selects the salary band "Voluntary" (`efate/_dev/js/modules/job-submit-form.js:69-85`). *Default: optional "default salary band" per job type (vwok: volunteer types → Voluntary).*
20. **Close date on the job page** shows only when the job's duration differs from 45 days (`efate/single-job_listing.php:140-143`). *Default: always show the close date (it's in JSON-LD `validThrough` anyway).*
21. **Organisation directory order:** orgs with a live job first, then the rest, each A–Z, plus a promo text box and "Update your profile"/"Contact us" button (`wpo/templates/organisations-holder-page.php:75-117`). *Default: parity (PJ-38), promo text = a normal block on the Organisations page.*
22. **Per-job company website (`_CompanyURL`)** is collected but never shown (`custom_jr_job_author()` is never called with `$show_web_link`, `jre/includes/jre-frontend-functions.php:78`; `efate/single-job_listing.php:45`). *Default: drop the field; the job shows the org's website.*
23. **FXtender switches not yet read** ("first N jobs free", "first N jobs moderated", hover preview on listings, "days left" instead of date, visitor redirects, "apply with registered email only", email signature). *Default: treat as OFF unless query 50 shows them ON; an email signature becomes the tenant email-layout footer.*
24. **Sign-in return URL** (legacy `/login/?redirect_to=…&role=…`). *Default: every sign-in link carries a return URL; the role hint is dropped.*
25. **Alert send time** (`wja/wp-job-alerts.php:110` schedules daily from `tomorrow GMT` = 00:00 UTC = 11:00 Vanuatu). *Default: per-tenant send hour, vwok 00:00 UTC (PJ-48).*
26. **Manual "Process Job Alerts" button** (admin bar, `wja/wp-job-alerts.php:85-96`). *Default: none; the missed-run warning covers it and a super admin can trigger the scheduled job.*

## Queries added (QUERIES-19NOV.sql)

37 shortcodes/forms on published pages · 38 remaining `jr_*` options · 39 WP-cron hook names · 40 application attachments (CV/cover letter) · 41 expiry/cancel reasons · 42 pending and draft jobs by year and type · 43 employer contact fields on active users · 44 resumes by year · 45 Wordfence 2FA users · 46 `THANKSFROMYCV` meta · 47 Overseas/remote job addresses · 48 recent use of featured-category.

Added by the code walk: 49 page templates in use (feeds, confirm, contact pages) · 50 FXtender settings (`jr_fx_*` options, values masked) · 51 email template switches and subjects (`_custom_*`, standalone `jr_nu_*`) · 52 category custom forms and how many jobs use their fields · 53 jobs whose company name differs from the organisation name · 54 unconfirmed accounts by registration year · 55 close dates chosen vs the 45-day maximum · 56 selected keys inside the serialised `jr_options` array (bool vs 'yes').

---

## 1. Public site (layout, pages, navigation)

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Header banner (desktop) + listing banner (320×50 mobile) → ycv.vu | QR§6 `jr_enable_header_banner=1`, `jr_enable_listing_banner=1`; `efate/header.php:21-25` (desktop), `:76-81` (mobile) | ON | COVERED | Decision: header banner (PJ-84/67) |
| Logo | The header prints the WP Customizer header image, not `jr_logo_url` (`efate/header.php:29-36`) | ON | COVERED | PJ-20 site settings (import the image in use) |
| Main menu: Jobs, Volunteering, For Employers, Organisations, About us; Top: Contact; Bottom: Powered by YCV, Password Reset, Submit Job, Login | QR§26 | ON | COVERED | PJ-103 menus, PJ-67 import |
| Home page: hero image (+ retina) + search, 3 feature boxes, "Latest job listings" (5 newest, no featured priority, RSS icon → `/rss-feed/`), page content | `efate/vantage-home-page.php:8-63,89-153,163-200,216`; meta boxes from `jre/functions/home-page-meta-functions.php:32-57` (boxes 4–6 defined but never rendered); multi-image-metabox is not used by any template | ON | COVERED | Decision: home page (PJ-39/84/103); the decision's "featured first" wins over legacy |
| Mobile menu (slide-in panel) + Login link in the header | `efate/_dev/js/modules/sitewide-functions.js:31-59`, `efate/header.php:55-68`, `efate/includes/mobile-nav-frame.php` | ON | COVERED | PJ-103 menus (no JS needed) |
| Sidebar / search bar / filter bar shown | QR§6 `jr_show_sidebar/searchbar/filterbar=1`; sidebar "Submit a job" box + "Browse by" (`efate/sidebar-sjob.php`, `efate/sidebar-nav.php`) | ON | COVERED | Decision: listing filters (PJ-36) |
| Breadcrumbs | `jr_options` `breadcrumbs b:1` (QR§3); FXtender breadcrumbs `fx/includes/features.php:60-175` | ON | COVERED | Decision: job URLs (breadcrumbs + JSON-LD), PJ-104 |
| Pages: About us, Contact (contact-2), For Employers, Organisations, Volunteering, T&C | QR§9, CRAWL§3.1 | ON | COVERED | PJ-67/103, PJ-89 (T&C) |
| Land Law Reforms, Organisation Competition | QR§9 | stale | DROPPED | Decision: not imported → 410 |
| Contact page: form (name, email, message, honeypot → admin email) + Google map | QR§7, `jr/tpl-contact.php:27-46`, `jr/includes/views.php:2393-2480` | ON | COVERED | Decision: contact page (PJ-102) |
| Captcha on contact forms | QR§6 `jr_captcha_contact_forms_enable=no` | OFF | COVERED | Decision: spam/bots (Turnstile everywhere) |
| Blog | QR§8 (0 posts, 1 draft), `jr_disable_blog` empty | UNUSED | DROPPED | Import scope 1 |
| Comments | QR§16 (table empty) | UNUSED | DROPPED | Import scope |
| JobRoller system pages (Dashboard, My Profile, Edit Job, Submit, Login, Register, Password Recovery/Reset, Confirm, Resend, Purchase Job Pack) | QR§9 | ON | COVERED | Replaced by /account (Decision 2, PJ-82/83/109); 301s in PJ-42 |
| Purchase Resume Subscription, Resumes restricted, Edit Resume | QR§9 | — | DROPPED | Decision 1 |
| "Sign-up to our Email" /sign-up, "Application form", "Job email text" pages | QR§8/§9, CRAWL§3.6 | unknown | GAP | Gap 14; queries 37, 49 |
| Paid / voluntary jobs RSS page templates (home page links `/rss-feed/`) | `efate/feeds/paid-jobs-feed.php`, `efate/feeds/voluntary-jobs-feed.php`, `efate/wrapper.php:2-5`, `efate/vantage-home-page.php:166` | ON? | COVERED | Decision: RSS on hold (PJ-116); query 49 shows which pages use them |
| A5 Vanuatu Wok booklet PDF (linked) | CRAWL§7 | ON | COVERED | PJ-63 (referenced files imported) |
| Google Analytics (UA tag via `jr_google_analytics`) | QR§18; printed in the footer by `jr/includes/setup-theme.php:8` (`efate/includes/google-and-facebook-scripts.php` is empty) | dead | DROPPED | Decision: analytics (Cloudflare Web Analytics) |
| Facebook / Twitter / ShareThis IDs, Feedburner | QR§6 (empty) | OFF | OFF | – |
| Indeed job feed integration | QR§6 `jr_indeed_publisher_id` empty, `jr_indeed_front_page` empty | OFF | OFF | – |
| Footer: "Powered by Youth Challenge Vanuatu" | QR§26 | ON | COVERED | PJ-103 menus |
| English only | Decision | – | COVERED | Decision: English only |
| Recently viewed jobs (`_viewed_jobs` meta on 2,219 users; last 5, seeker dashboard only, no "Viewed" label in listings) | QR§12, `jr/includes/users.php:257-275`, `jr/tpl-job-seeker-dashboard.php:43-49` | ON | COVERED | Decision: viewed jobs (localStorage, PJ-111); server meta not imported |
| Saved / starred jobs (`_starred_jobs` on 240 users). The "Star job" link sits in the hidden job-page footer bar, so today it can't be clicked; the list shows in the seeker dashboard | QR§12, `efate/single-job_listing.php:176,193-199`, `jr/includes/users.php:287-300`, `jr/tpl-job-seeker-dashboard.php:35-41` | hidden | COVERED | Decision: saved jobs (PJ-83/66) |
| Print job (`window.print()`) | CRAWL§3.3; the link is inside `<ul class="section_footer" style="display:none">` (`efate/single-job_listing.php:176,202`) | hidden | COVERED (implied) | Print stylesheet on the job page, no JS (PJ-37 note) |
| AddThis / ShareThis share buttons | CRAWL§3.3; no share code in efate (ShareThis id empty, `efate/single-job_listing.php:56-61`; `selfserv_sexy` share link never defined, `:206`) | broken (AddThis shut down 2023) | DROPPED | Share images make manual sharing look good (Decision: share images, PJ-105) |
| Accessibility | – | – | COVERED | Decision: accessibility (WCAG 2.2 AA) |

## 2. Search, listings and filters

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Keyword search `?s=` ("Job Keyword") | CRAWL§9, `efate/includes/search-wrap-user-inputs.php:1-9` | ON | COVERED | Decision: search (Postgres FTS), PJ-36 |
| Location search `?location=`: a fixed picker (jQuery UI combobox with groups National / Islands / Areas / Other) and a text match on the job's short address, no geocoding | CRAWL§9, `efate/includes/search-wrap-user-inputs.php:15-53`, `efate/_dev/js/modules/sitewide-functions.js:9-29`, `efate/includes/geolocation.php:76-118`, `fx/includes/features.php:934-970` | ON | COVERED | Decision: filter URLs /jobs/{location} (PJ-36/99) |
| Radius search (`jr_distance_unit=km`) | QR§6; `jr_radius_dropdown()` is never called by efate and efate's `jr_radial_search()` ignores the radius (`efate/includes/geolocation.php:76-118,174-196`); `?radius=` is only passed through (`efate/includes/forms/filter/filter-form.php:66-68`) | not in UI | OFF | Dropped (location tree, PJ-99); `?radius=` dropped by the junk-URL rule (Gap 10) |
| `?location=Overseas` hack (injects a Wellington NZ address) | `jre/includes/class-jre-job-submission-process.php:83-89` | ON | DROPPED | "Overseas" is a location (Gap 12) |
| Job-type checkboxes `?{type}=show&action=Filter` (volunteer types excluded; hidden on type pages) | CRAWL§9, `efate/includes/forms/filter/filter-form.php:83-151` | ON | COVERED | Decision: listing filters + /jobs/{type} |
| Category / type / salary taxonomy pages `/job-category/…`, `/job-type/…`, `/job-salary/…` | CRAWL§3.5, QR§19 permalinks | ON | COVERED | Decision: filter URLs; 301 map PJ-42 |
| Salary band filter | `jr_enable_salary_field=1` | ON | COVERED | Decision: listing filters |
| Job date archive (today / week / last week / month) | CRAWL§3.1/§9, `efate/sidebar-nav.php:42`, `jre/includes/jre-frontend-functions.php:35-43` | ON | COVERED | "Date posted" filter (Decision: listing filters); 301 in Gap 10 |
| Legacy query URLs → new URLs | CRAWL§9 | ON | GAP | Gap 10 |
| 20 jobs per page + pagination `/jobs/page/N/` | QR§6 `jr_jobs_per_page=20`, CRAWL§3.2 | ON | DROPPED | Decision 16 (no pagination); `/page/N` → 301 to /jobs |
| Featured block above the list, newest first; it follows the active filters / job-type page | `jr_featured_jobs_sort=newest`; `jre/includes/class-jre-query.php:57-76` | ON | COVERED | Decision: listing order |
| Featured in category | QR§13 (62 jobs ever) | rare | DROPPED (vwok) | Decision: listing order |
| Volunteer jobs listed separately (/volunteer-jobs): main queries drop type "Voluntary" and its children; type term meta `is_volunteer_job_type` | AUDIT, QR§9, `jre/includes/class-jre-query.php:33-55`, `efate/volunteer-job-listings.php`, `jre/includes/class-jre-taxonomies.php:31-60` | ON | COVERED | Decision: job type pages ('listed separately') |
| Expired jobs hidden (`jr_expired_action=hide`) | QR§3 | ON | COVERED (changed) | Decision 17 + "expired jobs (confirmed)" |
| Empty categories hidden (`jr_show_empty_categories` empty) | QR§6 | ON | COVERED | Decision: filter URLs (empty pages noindex, not in sitemap) |
| Dynamic (AJAX) search results | `jr_dynamic_search_results` empty | OFF | OFF | – |
| Organisation directory: type/size filters (client-side), orgs with a live job first then A–Z, no job count shown, promo text + CTA | AUDIT, CRAWL§9, `wpo/templates/organisations-holder-page.php:33-117`, `wpo/templates/organisation-card.php:27-55`, `efate/_dev/js/modules/organisations-page.js` | ON | COVERED / GAP | PJ-38 (area of focus dropped); order = Gap 21 |
| Sidebar "Browse by": job type, salary, category, date posted | `efate/sidebar-nav.php:12-44` | ON | COVERED | Decision: listing filters |

## 3. Job posting form (employer)

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Multi-step submit: Register (if signed out) → Job details → Preview → Select plan → Pay/Thank you; the job is saved as a draft at step 2 and "Continue" resumes it (486 drafts) | QR§8, `efate/includes/forms.php:1429-1462,1525-1562`, `efate/includes/template-tags.php:120-139`, `efate/tpl-submit.php` | ON | COVERED | Decision: job description editor (multi-step + drafts), PJ-82 |
| Title (required), description (required; plain textarea because `jr_html_allowed` is empty, tags stripped) | `efate/includes/forms/submit-job/submit-job-form.php:51-52,164-183`, `efate/includes/forms.php:1156-1164,1215-1228` | ON | COVERED | Decision: Lexical editor |
| Category (required, editable later) | `jr_submit_cat_required=1`, `jr_submit_cat_editable=1`; `efate/includes/forms/submit-job/submit-job-form.php:71-99`, `efate/includes/forms.php:1230-1244` | ON | GAP | Gap 15 |
| Job type (required), salary band (optional). Free-text salary `_displayed_salary` (3,100 jobs) has no input on the public form: admin meta box only, shown only in RSS | QR§13, `efate/includes/forms/submit-job/submit-job-form.php:54-69,117-139`, `jre/includes/admin/class-jre-admin-job-listing-post.php:88-92`, `jre/includes/class-jre-rss-customisations.php:46-50` | ON | COVERED | Decision: salary + job type clean-up; PJ-19/64 |
| Company name (`_Company`, free text, required, emptied by JS on every new job) | QR§13 (6,395), `efate/includes/forms/submit-job/submit-job-form.php:25-30`, `efate/_dev/js/modules/job-submit-form.js:12-16` | ON | GAP | Gap 4; query 53 |
| Company website (`_CompanyURL`, "http://" stripped) – never displayed | `efate/includes/forms/submit-job/submit-job-form.php:37-40`, `efate/includes/forms.php:1166-1173`, `jre/includes/jre-frontend-functions.php:78` | stored only | GAP | Gap 22 |
| Invoice contact name shown read-only ("email admin to change") for non-admins | `axi/includes/class-axi-user-validation.php:39-56`, `efate/includes/forms/submit-job/submit-job-form.php:32-36` | ON | COVERED | PJ-56 (Xero contact = org); show the billing name on the plan step (PJ-82) |
| Company logo per job (upload + "use as my default logo" checkbox) | `efate/includes/forms/submit-job/submit-job-form.php:42-43`, `efate/includes/template-tags.php:726-759`, `fx/includes/pro/features.php:1908-2054,2156-2240` (AJAX `jr_fx_load_company_logo`) | ON | COVERED | Org logo (PJ-18/37); agency client logos (Decision: agencies) |
| How to apply (text; URLs and emails auto-linked on the job page) | QR§13, `jr_submit_how_to_apply_display=1`; `efate/includes/forms/submit-job/submit-job-form.php:186-207`, `efate/single-job_listing.php:80-104` | ON | COVERED | PJ-19/64 |
| Per-job application email ("Applications email address", defaults to the user's email, validated in JS; hidden when apply online is off) | QR§13 (6,391), `fx/includes/jscripts.php:349-420`, `fx/includes/pro/features.php:388-399`, `efate/_dev/js/modules/job-submit-form.js:87-103` | ON | COVERED | PJ-19 `applicationsRecipient` |
| "Disable Apply Online" checkbox (`jr_fx_disable_apply_online`) | QR§13 (6,248), `fx/includes/jscripts.php:306-343`, `fx/includes/pro/features.php:405-418` | ON | COVERED | Decision: apply form (per-job switch) |
| Location: Island select → Town select (11 islands incl. Other/Overseas), required by JS; written as "Town, Island" into the address; server geocodes it to lat/lng (Google) | `efate/includes/geolocation-select-holder.php:5-23`, `efate/_dev/js/modules/location-selector-functions.js:22-56,74-106`, `efate/_dev/js/modules/regions-and-towns.js`, `efate/includes/forms.php:1131-1152`, `efate/includes/geolocation.php:267-330` | ON | COVERED | PJ-17/99; lat/lng not needed (no map, see §4) |
| "Multiple Locations?" checkbox: hides the picker and shows a free-text address; old addresses that don't match the picker open in this mode | `efate/includes/geolocation-select-holder.php:1-4`, `efate/_dev/js/modules/location-selector-functions.js:57-70,107-146` | ON | GAP | Gap 2, query 36 |
| Close date picker (Pikaday over FXtender's "Job Duration" days field; tomorrow…max; on edit the max counts from the publish date; relist pre-fills 30; caption still says "30 days if no date") | QR§13 (6,191), `jr_jobs_default_expires=45`; `efate/_dev/js/modules/job-submit-form.js:19-67`, `fx/includes/jscripts.php:260-303`, `efate/includes/forms/submit-job/submit-job-form.php:221-230`, `jre/includes/class-jre-job-submission-process.php:91-107` | ON | COVERED | Decision: job duration (close date, plan max) |
| Job description PDF upload (new jobs only, PDF only) (1,104 PDFs) | QR§33, USAGE, `efate/includes/forms/submit-job/submit-job-form.php:103-113` | ON | COVERED | Deep sweep (PJ-82) |
| Logo shown on every job (`jr_fx_opt_jobs_lister_persistent_logo_gravatar=yes`) | QR§19 | ON | COVERED | Org logo on job (PJ-37) |
| Terms checkbox on submit (`jr_enable_terms_conditions` empty) | QR§6 | OFF | COVERED | PJ-89 consent lines |
| `jr_jobs_submit_text` (sidebar "Submit a job" box) and `boosted_listing_text` (under add-on checkboxes) | QR§6, `efate/sidebar-sjob.php:9`, `efate/includes/template-tags.php:522-547`, `jre/includes/admin/class-jre-admin-jobroller-enhancements.php:92-110`, `jre/includes/class-jre-job-submission-process.php:191-227` | ON | GAP | Gap 13 |
| Edit live job, no re-approval (`jr_allow_editing=1`, `jr_editing_needs_approval` empty) | QR§6, `efate/includes/forms.php:985-1000` | ON | COVERED | Deep sweep decision |
| Job tags (`job_tag`) | QR§10 (no terms) | UNUSED | DROPPED | Decision: taxonomy names |
| Agency "post for client / confidential" | – (new) | – | COVERED | Decision: agencies |
| Category custom fields (form builder; AJAX `app-render-job-form` exists but the JS never binds it, so the fields only appear when editing) | `jr/includes/custom-forms.php:5-35`, `efate/_dev/js/modules/job-submit-form.js:183-197`, `efate/includes/forms.php:1257-1263` | rare | GAP | Gap 8, query 52 |
| Validation: jQuery Validate (required fields; TinyMCE workaround), location required alert, "processing" spinner on submit | `efate/_dev/js/modules/job-submit-form.js:132-181`, `efate/_dev/js/modules/location-selector-functions.js:73-91`, `efate/_dev/js/modules/sitewide-functions.js:61-99` (calls a missing `validateLocationSelected()`) | ON | COVERED | PJ-82 (server-side validation, accessible errors) |
| Admin posting: picks a Xero contact at the plan step; invoice field hidden for admins | `axi/includes/class-axi-invoice-manager.php:325-359`, `efate/includes/forms/submit-job/submit-job-form.php:33` | ON | GAP | Gap 5 |
| Plan step: only plans for the job's category + type, job limit 1–49; plan includes Enhanced/Premium shown as ticked; Premium purchase also adds Enhanced for 30 days | `efate/includes/forms/select-plan/select-plan.php:6-37`, `jre/includes/class-jre-job-submission-process.php:191-227,274-276` | ON | COVERED | PJ-21/87 (Premium not seeded for vwok, Decision: listing order) |
| Coupon field at checkout | `cpn/coupons.php:70-73,241-410` | ON | COVERED | PJ-22/65 |
| Relist: post date reset to now, job goes through payment again | `jre/includes/class-jre-job-submission-process.php:96-105`, `efate/includes/forms.php:1080-1087,1600-1612` | ON | COVERED | Decision: relisting kept (PJ-33) |
| Volunteer types auto-select salary "Voluntary" | `efate/_dev/js/modules/job-submit-form.js:69-85` | ON | GAP | Gap 19 |
| Disable "Apply with LinkedIn" checkbox | `fx/includes/jscripts.php:425-452` (only if LinkedIn apply is on) | ? | DROPPED | Decision: apply form (LinkedIn post-MVP); query 50 |

## 4. Job page

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Flat URL `/jobs/{slug}` | CRAWL§3.3 | ON | COVERED | Decision: job URLs |
| Title, type, org (linked only if the company name equals the org name), location, category/type/salary line, description, category custom fields, PDF link, how to apply | CRAWL§3.3, `efate/single-job_listing.php:28-147`, `jre/includes/jre-frontend-functions.php:46-90` | ON | COVERED | PJ-37 |
| "For further information contact the employer…" notice (+ "apply online below" when apply is on) | `efate/single-job_listing.php:158-174` | ON | COVERED | PJ-37 copy (per-tenant text) |
| "Closes {date}" only when the duration differs from 45 days | `efate/single-job_listing.php:139-144` | ON | GAP | Gap 20 |
| Footer bar (Apply button, Star, Print, View map, Edit) hidden with inline `display:none` | `efate/single-job_listing.php:176-212` | hidden | DROPPED | Apply form is inline (PJ-45); saved jobs get a visible button (PJ-83) |
| Inline apply form (hidden when apply online is off or the job expired) | CRAWL§3.3, `jr/includes/actions.php` `job_footer`, `fx/includes/jscripts.php:345-357` | ON | COVERED | PJ-45 |
| View counter (total + daily; `jr_daily_count`, `jr_total_count`, 9.29M views), counted on every page render | QR§13/§14, `efate/single-job_listing.php:26` | ON | COVERED | PJ-37 view beacon, PJ-64 import, PJ-110 |
| View counts shown publicly (`jr_ad_stats_all=1`; template tests `== 'yes'`) | QR§6, `efate/single-job_listing.php:149` | ON (query 56) | GAP | Gap 7 |
| Map ("View map") | 6,117 jobs with lat/lng, but the link is inside the hidden footer bar (`efate/single-job_listing.php:176,204`) and needs the dequeued map scripts (`jre/includes/jre-frontend-functions.php:25-33`); FXtender may also hide maps (`jr_fx_opt_jobs_gmaps`, `fx/includes/jscripts.php:221-250`) | not visible | OFF | No map; lat/lng not imported (they are geocoded town names). Query 35 no longer needed |
| JobPosting structured data (Yoast + theme) | AUDIT | ON | COVERED | PJ-37/104 |
| Yoast OG image per job (6,691) / 1200×630 generated image (job thumbnail resized with Imagick, error emailed to admin) | QR§13, AUDIT, `jre/includes/class-jre-job-submission-process.php:117-189` | ON | COVERED | PJ-105 (regenerated, not imported) |
| Expired job URL behaviour (when reachable: "Job Expired {date}" notice replaces How to apply) | QR§3 hide → 404 today, `efate/single-job_listing.php:84-88` | – | COVERED | Decision 17 (200 + banner, 410 after 12 months) |
| Print, share | CRAWL§3.3 | hidden / none | see §1 | – |
| Similar jobs | – (new, for expired) | – | COVERED | Decision 17 |

## 5. Organisations

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Org = lister user + meta (name in `nickname`) | AUDIT | ON | COVERED | PJ-18 (real organisation), PROPOSAL-ROLES |
| Fields on the front-end profile: org name (max 35 chars, "-" key blocked), type (6 values), area of focus, size (9 bands), about ("mission and main activities"), phone, logo (`company-logo` 158), cover image (`profile_picture` 296, WP media uploader), website, Twitter/Facebook/LinkedIn (`twitter_id`/`facebook_id`/`linkedin_profile`, 541) | QR§12, `efate/tpl-profile.php:93-295`, `jre/includes/class-jre-user-profile-extensions.php:283-331`, `efate/assets/js/frontend-image-uploader.js` | ON | COVERED | PJ-18 (type, size, logo, cover, website, socials, phone, location, about) |
| Yoast user contact fields (facebook/twitter 86; instagram/linkedin/youtube/myspace/… 55, googleplus 36): admin-only, not on the front-end form, never shown | QR§12; no efate/plugin code reads them | admin only | DROPPED (proposed) | Import only live networks, and only where the org's own field is empty; mention in PJ-62 |
| Area of focus | QR§10 (no terms) | UNUSED | DROPPED | Decision: taxonomy names |
| Phone (area code + number; the `tel:` link swaps every "0" for "+64") / contact job title / physical location | QR§12 (255/145), `efate/tpl-profile.php:54,263-266`, `efate/author.php:6-16,85-87,126` | ON | GAP | Gap 18, query 43 |
| Public page `/organisation/{nickname}`: slug = nickname lower-cased, spaces → "-", macrons stripped; lookup turns "-" back into spaces; others get 404 (`/author/` only for blog authors) | CRAWL§3.4, `jre/includes/class-jre-user-profile-extensions.php:547-645` | ON | COVERED | PJ-38; 301 in PJ-42 (use the same slug rule) |
| Org page: cover, logo, type, phone, website, socials, About, Location, Size, current job listings, "Do you work for X? Contact us to become the administrator" | `efate/author.php:1-190` | ON | COVERED | PJ-38; join request (Decision: email list) |
| Org OG image (Facebook image, else cover) | `jre/includes/class-jre-user-profile-extensions.php:655-679` | ON | COVERED | PJ-105 |
| Page approval: listing request → admin enables → "now live" email (`listing_request` 27 open, `enable_organisations_page` 32 on, `org_listing_email_sent` 35); the admin email repeats on every profile save while the box is ticked | QR§12/§15, `efate/tpl-profile.php:106-131`, `jre/includes/class-jre-user-profile-extensions.php:304-351,690-724` | ON | COVERED | Decision: organisation pages approval |
| Directory (orgs with the page enabled; live-job orgs first; no count shown) | `wpo/templates/organisations-holder-page.php:75-102` | ON | COVERED / GAP | PJ-38; order = Gap 21 |
| Org RSS feed (29) | CRAWL§6 | ? | COVERED | Decision: RSS (PJ-116 hold) |
| Email on the org page is the site admin's ("Contact us to become the administrator"), not the org's | CRAWL§3.4, `efate/author.php:176-182` | ON | COVERED | Join request form instead of a mailto (Decision: email list) |
| Yoast SEO title/description per org (88) | QR§12 | ON | GAP | Gap 17 |
| Multiple users per org / invites | AUDIT (none) | – | COVERED (new) | PROPOSAL-ROLES; PJ-29 |
| Deleted employer → jobs reassigned to `archive` user | AUDIT, `jre/includes/class-jre-user-profile-extensions.php:752-790` | ON | COVERED | Jobs belong to the org; Decision: account deletion (PJ-89) |
| "Trusted" (invoice-me, publish before payment) (`can_pay_by_bank_transfer` 79 + billing email 71, admin-only fields) | QR§15, `jre/includes/class-jre-user-profile-extensions.php:388-430`, `jre/includes/class-jre-job-submission-process.php:283-334` | ON | COVERED | Decision: one 'trusted' switch |
| `_approved_job_lister` (29; set when an admin presses Accept; any past published/expired job also counts) | QR§12, `jre/includes/admin/class-jre-admin-job-listing-post.php:149-152`, `jre/includes/class-jre-job-submission-process.php:336-346` | ON | COVERED | Superseded by 'trusted' |
| Xero contact code (71) | QR§12 | ON | COVERED | PJ-62/56 |

## 6. Accounts, registration, sign-in

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Register: role radio (employer default / seeker), first name, username, company name (hidden for seekers), email, password, honeypot | AUDIT, `efate/includes/forms/register/register-form.php:32-134`, `efate/_dev/js/modules/register-form.js`, `jre/includes/class-jre-user-registration.php:40-54` | ON | COVERED | PJ-29 (user + org together), Decision: sign-in |
| reCAPTCHA at registration (`jr_captcha_enable=1`); the anti-spam question is used on the apply form for guests, not at registration | QR§6, `efate/includes/forms/register/register-form.php:119-121`, `efate/includes/forms/application/application-form.php:69-76` | ON | COVERED | Decision: spam/bots (Turnstile + disposable-email block) |
| Registration Honeypot plugin (`th_rh_name` field) | active plugins, `efate/includes/forms/register/register-form.php:34-35` | ON | COVERED | PJ-29 |
| Email confirmation `/confirm/?confirm=KEY`, resend page, admin manual confirm; unconfirmed users can't sign in and are sent to /confirm/ (`confirmation_key` 10,956) | AUDIT, QR§12, `efate/includes/confirm.php`, `efate/includes/resend-confirmation.php`, `jre/includes/class-jre-user-registration.php:62-73,115-130`, `jre/includes/admin/class-jre-admin-users-table.php:127-175` | ON | COVERED | Email code/link verifies (PJ-109); no manual confirm needed |
| Username or email sign-in; "Remember me" ticked by default | AUDIT, `efate/includes/forms/login/login-form.php:27-43` | ON | COVERED | Deep sweep: email only; username kept for reference |
| Password reset / recovery | QR§9 | ON | COVERED | PJ-109 |
| WP password hashes | – | ON | COVERED | PJ-34 |
| `last_login` tracking (3,418) | QR§12 | ON | COVERED | PJ-62 migration rule |
| Login return URL `redirect_to` | CRAWL§3.6, `efate/includes/forms/login/login-form.php:42` | ON | GAP | Gap 24 |
| Username must not match an existing Xero contact name | `axi/includes/class-axi-user-validation.php:58-76` | ON | DROPPED | Email-only sign-in; Xero contact keyed by org (PJ-56) |
| Change password on the profile page | `efate/tpl-profile.php:63-90`, `jre/includes/class-jre-user-profile-extensions.php:371-386` | ON | COVERED | PJ-109 (optional password) |
| Recruiter role (`jr_allow_recruiters` empty) | QR§6 | OFF | OFF | Agencies decision covers it |
| Seekers allowed (`jr_allow_job_seekers=1`) | QR§6 | ON | COVERED | Decision: seeker accounts kept |
| Seeker profile + preferences (career status, availability, keywords, location, job types, relocate/travel: 361; socials 541) and "Job recommendations" built from them | QR§12, `efate/includes/forms.php:118-195`, `jr/tpl-job-seeker-dashboard.php:51-57`, `jr/includes/users.php:560-600` | ON | DROPPED | Decision: no seeker profiles |
| Admin bar hidden for non-admins | `jr_remove_admin_bar=1` | ON | COVERED | n/a: /account is separate from admin (Decision 2) |
| Media library: users see only their own uploads | AUDIT | ON | COVERED | Access rules (PJ-10/18) |
| Account self-deletion ("Delete Me" JS, plugin missing) | AUDIT, `efate/_dev/js/modules/delete-account-form.js` | OFF | DROPPED | Decision: account deletion |
| MailChimp subscribe at registration (code needs an `update_subscription` field that the form doesn't have) | Import scope, `jre/includes/class-jre-user-registration.php:43-49,78-107` | OFF | DROPPED | Import scope (revoke key, PJ-75) |
| Sessions | – | – | COVERED | Decision: sessions (keep me signed in) |
| Log in as user (User Switching, wpackagist, no custom code) | active plugins, `composer.json` | ? | GAP | Gap 9 |
| 2FA (Wordfence login security; `wfls-last-login` 2,570) | QR§12 | ? | COVERED | Decision: security (post-MVP); query 45 |
| Admin/editor roles (4 admins, 1 editor, 1 contributor); editors can manage users but never see or edit admins | QR§31, `jre/includes/admin/class-jre-admin-users-role-extensions.php:35-88` | ON | COVERED | PROPOSAL-ROLES (site manager) |

## 7. Applications

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Apply form: name, email, message (all required), CV, cover letter (optional, max 10 MB total), anti-spam question for guests, "processing" notice; prefilled for signed-in users; job owner can't apply to own job | CRAWL§3.3, `efate/includes/forms/application/application-form.php:14-83`, `efate/includes/forms.php:421-560`, `jr/includes/capabilities.php:57-79` | ON | COVERED | Decision: apply form (CV now required; cover letter optional, PJ-45) |
| Captcha on apply (`jr_captcha_application_form_enable=no`) | QR§6 | OFF | COVERED | Turnstile (PJ-45) |
| LinkedIn apply (fxtender) | AUDIT, `fx/includes/pro/features.php:78,1631-1700` | ? | DROPPED | Decision: apply form (post-MVP) |
| Guest apply (only signed-in applicants recorded as a job→user connection). JobRoller's default `apply_reg_users_only = 'yes'` would block guests ("Only registered users can apply"); the guest anti-spam question suggests vwok turned it off | STATUS notes, `efate/includes/forms.php:405-418,645-663`, `jr/includes/options.php:100`, `jr/includes/capabilities.php:57-63`, `fx/includes/pro/features.php:2367-2436`; query 56 | ON | COVERED | Decision: apply form ('account required' off) |
| Email to the job owner, redirected to the per-job recipient; Reply-To = applicant; copy to applicant with the files; copy to admin (`jr_bcc_apply_emails=1`); files deleted after sending (legacy keeps no CVs) | QR§6, `efate/includes/forms.php:603-646`, `fx/includes/pro/features.php:296-325` | ON | COVERED | Decision: admin copy of applications |
| Applications stored + both dashboards (employer "Applications" tab, seeker "My applications") + CSV export + admin column/meta box | AUDIT, QR§13 (`_jr_job_application` 415), `fx/includes/pro/features.php:50-63,2440-2560,2879-3040,3085-3145` | ON | COVERED | PJ-25/46/82/83 |
| Past applications/CVs | – | – | DROPPED | Decision 1 |
| Retention | – | – | COVERED | Decision 18 (PJ-88) |
| Attachment use (cover letters really sent?) | – | ? | – | Query 40 (informational) |

## 8. Job alerts

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Subscription (seeker dashboard): keywords (comma list), locations (comma list, free text), types, categories, active/inactive (248 active / 312 inactive); matching is a substring test on title/body and location | QR§12/§24, `efate/includes/forms.php:198-380`, `efate/_dev/js/modules/job-seeker-dashboard-functions.js`, `wja/includes/class-md-process-job-alerts.php:24-100` | ON | COVERED | Decision: job alerts (Indeed-style), PJ-47/66 |
| Daily, newest 5 matching jobs per email, background queue | QR§6 `jr_job_alerts_*`, `wja/includes/class-md-process-job-alerts.php:102-108` | ON | COVERED | PJ-48 (vwok 5) |
| Run time: midnight UTC (log entries at 11:00 VUT) | QR§8 job-alerts-log latest 11:00:03, `wja/wp-job-alerts.php:107-112` | ON | GAP | Gap 25 |
| Manual "Process Job Alerts" button (admin bar) | `wja/wp-job-alerts.php:79-127` | admin | GAP | Gap 26 |
| Unsubscribe: dashboard settings; `/confirm/?unsubscribe=KEY` sets the status inactive (raw SQL, injectable) | QR§6 email body, `efate/includes/confirm.php:94-113` | ON | COVERED | Decision: alerts (one-click unsubscribe) |
| Alert email template (`%joblist%`, per-job line) | QR§6 | ON | COVERED | PJ-27/50 seed |
| Per-user alert RSS feed (`jr_alert_feed_key` 982; `jr_job_alerts_feed` empty) | QR§6/§12 | OFF | OFF | – |
| Run log (`job-alerts-log` 2,110; one post per run listing every subscriber's email and criteria) | QR§8, `wja/includes/class-md-process-job-alerts.php:110-170`, `wja/includes/class-md-post-type-job-alerts-log.php` | ON | COVERED | PJ-48 run log (counts only; per-email detail via the email log, Decision: job alerts) |
| Alert matching index: `jr_alerts` table row per published job, rows deleted after each run; admin "Current Alert's Info" counts | `wja/includes/class-md-process-job-alerts.php:236-301`, `jre/includes/admin/class-jre-admin-jobroller-enhancements.php:115-185` | ON | DROPPED | PJ-48 queries new jobs since the last run |
| Duplicate theme cron `jr_job_alerts` | USAGE, `jr/includes/cron.php:18,60-67` | ? | DROPPED | USAGE |
| Guest alerts / double opt-in / weekly | – (new) | – | COVERED | Decision: job alerts |

## 9. Commerce: plans, packs, coupons, orders, invoices, Xero

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Plans: Basic 3,900; Enhanced 5,900 (featured 30 d); 5-pack 17,500; 10-pack 33,000; Volunteer free | QR§1 | ON | COVERED | Decision 11/12, PJ-21/87 |
| Plan restricted to categories/types (job type added to plans by jre); new categories auto-added to every plan | AUDIT, `jre/includes/class-jre-post-types.php:32-59`, `jre/includes/admin/class-jre-admin-jobroller-enhancements.php:37-48` | ON | COVERED | PJ-21 (unrestricted = all) |
| Relist price (= price) | QR§1 | ON | COVERED | Decision: relisting |
| Charging on (`jr_jobs_charge=1`) | QR§6 | ON | COVERED | PJ-31 |
| Job packs / credits never expire (`_jr_user_packs_active` 22) | QR§1/§12 | ON | COVERED | Decision: credits (PJ-24/65) |
| Pack expiry cron `jr_check_packs_expired` | USAGE | no handler | DROPPED | USAGE |
| Coupons (LINKPS 1,900 off, 501 uses); admin list columns | QR§5, `cpn/coupons.php`, `cpn/coupons-admin.php` | ON | COVERED | PJ-22/65 |
| Gateways: bank transfer / Invoice Me (100% of orders) | USAGE | ON | COVERED | Decision: payments (invoice only) |
| PayPal, 2Checkout, Authorize.net, Google Wallet; recurring `app_order_processing`; FXtender manual-payment shortcodes | USAGE, `fx/includes/pro/gateways/`, `fx/includes/pro/features.php:88-90` | UNUSED | DROPPED | Decision: payments |
| Orders `transaction` (5,902 pending, 66 failed, 40 activated) | QR§8 | ON | COVERED | PJ-23/65 (pending → invoiced) |
| Order marked paid (admin Activate/Complete/Pay buttons; Xero invoice updated on completion) | AUDIT, `jr/includes/payments/admin/order-single.php:272-278`, `axi/includes/class-axi-invoice-manager.php:194-204` | admin only | GAP | Gap 1 |
| Pending jobs page: "contact {admin email} to get your job manually approved and invoiced" | `efate/tpl-myjobs.php:149-155` | ON | COVERED | Decision: one 'trusted' switch (waiting text in /account) |
| Currency Vatu, 0 decimals | AUDIT | ON | COVERED | PJ-21 |
| Tax (`tax_charge=0`) | QR§19 | OFF | COVERED | PJ-91 |
| Resume-access plans | USAGE | UNUSED | DROPPED | Decision 1 |
| "Unlimited 6 month" pending plan | QR§8 | not sold | DROPPED | Decision 11 |
| Xero OAuth connect `/xero-auth` (admins only) | AUDIT, `axi/includes/frontend/class-axi-xero-auth-controller.php:29-95` | ON | COVERED | PJ-55 |
| Contact find/create `AXI-{id}` or override code | AUDIT | ON | COVERED | PJ-56 |
| Draft → authorised invoice; lines per plan/add-on/coupon; account codes 225/226/227; due 14 days; tracking none | QR§19 | ON | COVERED | PJ-57/59 |
| Payment recorded in Xero (not for Invoice Me) | AUDIT | OFF in practice | COVERED | No card gateway (Decision: payments) |
| `/invoice?id=` → Xero online invoice / HTML fallback (signed-in owner) | AUDIT, `axi/includes/frontend/class-axi-invoice-display-controller.php:39-122` | ON | COVERED | PJ-58 |
| Billing email added to the "job submitted" email | QR§12 (71), `jre/includes/class-jre-job-submission-process.php:307-334` | ON | COVERED | Decision: invoice parity / 'trusted' |
| Xero step log (`order-log` 6,053; admin meta box on the order) | QR§8, `axi/includes/class-axi-order-log-post-type.php:53-165` | ON | COVERED | PJ-57 (retry job; confirm it logs) |
| Member purchase rights | – (new) | – | COVERED | Decision: member purchase rights |

## 10. Emails

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Admin-editable subject/body/from (Advanced Emails "Custom Emails"; each template has an on/off switch read as `get_option(...) == 'yes'`) | AUDIT, QR§3 `_custom_*`, `aae/includes/admin/email-options.php`, `aae/includes/emails/email-functions.php`; query 51 | ON | COVERED | Decision: email templates (final), PJ-27/50 |
| New user email with the confirmation link `/confirm/?confirm=KEY` (custom template only if `jr_nu_custom_email` is 'yes', else "Your username and password" with the password in plain text); resend page | QR§6, `aae/includes/emails/email-functions.php:19-131,807-887`, `efate/includes/resend-confirmation.php:47` | ON (query 51) | COVERED | Decision: email list (welcome/verify); never email passwords |
| Admin copy of new user | `aae/includes/emails/email-functions.php:44-52` sends only when `jr_nu_admin_email` is 'yes'; it is empty | OFF | OFF | Not built |
| New job → admin: sent on every new submission, because the check is `'no' != jr_new_ad_email` and the option is empty | QR§6, `aae/includes/class-aae-email-controller.php:77-80` | ON | COVERED | Decision: email list (job submitted admin+employer) |
| Job submitted/live → owner (+ billing email for trusted orgs) (`jr_new_job_email_owner=1`) | QR§6, `aae/includes/emails/class-aae-job-submission-email.php:71`, `aae/includes/class-aae-email-controller.php:81-96` | ON | COVERED | Decision: one email per action |
| Approved (paid / volunteer variants; volunteer = type slug `voluntary` or its children) | AUDIT, `aae/includes/class-aae-email-controller.php:99-147`, `aae/includes/emails/class-aae-job-approved-email*.php` | ON | GAP | Gap 16 |
| Expiring reminders: 5 days and 1 day before close (`_jr_days_expire_reminder_email_sent` 4,184) | QR§13, `jr/includes/job-status.php:56-59,80-140`, `aae/includes/emails/email-functions.php:323-397` | ON | GAP | Gap 6 (decision text says 3 days) |
| Expired / cancelled + feedback text (`jr_expired_job_email_owner=1`) | QR§3, `aae/includes/emails/email-functions.php:405-512` | ON | COVERED | PJ-52, seed text PJ-27 |
| Order created → admin; order completed → owner ("job pending" + invoice link, can be switched off for job orders) | AUDIT, `aae/includes/emails/email-functions.php:141-314` | ON | COVERED | Decision: email list + one email per action |
| Application emails ×3 | AUDIT, `efate/includes/forms.php:603-636` | ON | COVERED | Decision: email list |
| Org listing request → admin; page live → owner (once, `org_listing_email_sent`) | AUDIT, `jre/includes/class-jre-user-profile-extensions.php:333-351,690-724` | ON | COVERED | Decision: email list |
| Resume subscription start/end; contact resume author; resume reminder (hard-coded to 2018-11-27); pack expired | QR§3/§19, USAGE, `aae/includes/emails/email-functions.php:519-799`, `aae/includes/tasks/class-aae-resume-reminder-emails-task.php:30-60` | OFF/dead | DROPPED | Decision: email list |
| Sender: JobRoller mails From "Vanuatu Wok <vanuatuwok@ycv.vu>"; Advanced Emails From noreply@ / Reply-To hello@ the site domain | `efate/functions.php:63-70`, `aae/includes/emails/email-functions.php:3-13` | ON | COVERED | Decision: email transport per tenant (from/reply-to are tenant settings) |
| FXtender email signature appended to emails sent on job pages | `fx/includes/pro/features.php:248-270,312-322` | ? | GAP | Gap 23; query 50 |
| Job image resize error → admin | `jre/includes/class-jre-job-submission-process.php:144-153` | rare | DROPPED | Share images are generated (PJ-105) |
| Test sites send all mail to one address | `jre/includes/class-jre-test-site-tools.php:29-36` | dev | COVERED | Decision: previews never email the public (PJ-94) |
| Contact form email | QR§7, `jr/includes/views.php:2393-2480` | ON | COVERED | PJ-102 |
| Alerts digest | QR§6, `wja/includes/class-md-process-job-alerts.php:102-108`, `jr/includes/alerts.php` (`jr_job_alerts_send_email`) | ON | COVERED | PJ-48 |
| Transport: Post SMTP → Gmail OAuth2 (ycv.vu); log `postman_sent_mail` | QR§21, QR§8 | ON | COVERED | Decision: email transport per tenant (PJ-112); email log PJ-50 |
| SPF/DMARC for sending domain | QR§34 | broken today | COVERED | PJ-03/96 |
| Previews never email the public | – | – | COVERED | Decision (PJ-94) |

## 11. Admin tools, reports, logs

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Approve pending jobs (Accept also marks the lister approved); job edit screen adds Location, Disable Apply Online (ticked by default on new admin jobs), Application recipient, Salary/Compensation, category custom fields; custom-fields and tags boxes removed | AUDIT, QR§8 (5 pending), `jre/includes/admin/class-jre-admin-job-listing-post.php:34-152` | ON | COVERED | PJ-32 + 'trusted' |
| User list columns (Jobs, Resumes, Resume subscription, Last login, Registered, Verified + verified filter + "confirm user" action); user edit: org fields, enable org page, invoice-me + billing email + Xero code, order history, applied jobs | AUDIT, `jre/includes/admin/class-jre-admin-users-table.php:42-185`, `jre/includes/class-jre-user-profile-extensions.php:47-75,136-280,388-545`, `fx/includes/pro/features.php:55,2933-2948` | ON | COVERED | PJ-30 (site-manager admin) |
| CSV: jobs + orders by month (selectable fields); job views | AUDIT, `wpjr/includes/class-wpjr-export-csv-form.php:27-414`, `wpjr/includes/class-wpjr-job-views-export-csv-form.php` | ON | COVERED | Decision: reports (PJ-53) |
| Site log: employer ends/cancels job (wp-site-logs; Tools → Site Logs) | AUDIT, `jr/includes/views.php:2155-2175`, `wpsl/includes/admin/class-md-wpsl-admin-menu.php:28-45` | ON | COVERED | Decision: credits traceable (org History tab) |
| JobRoller log (`jr_enable_log=1`, `uploads/at-logs`) | QR§6/§33 | ON | DROPPED | Workers Logs (Decision: monitoring) |
| WP Crontrol (cron UI) | active plugins | admin | COVERED | Alert run log + heartbeat (PJ-08/48) |
| Search & Replace plugin | active plugins | admin | DROPPED | n/a |
| UpdraftPlus daily backups | QR§27 | ON | COVERED | Decision: backups |
| Wordfence | active plugins | ON | DROPPED | Decision: security |
| Cloudflare plugin (cache purge) | active plugins | ON | COVERED | PJ-41 |
| User Switching | active plugins | ? | GAP | Gap 9 |
| Settings tabs added by jre: "Featured Add-ons Text", "Current Alert's Info"; Users → Area of focus; "Delete Empty Tags" button; media library filter | `jre/includes/admin/class-jre-admin-jobroller-enhancements.php:28-188`, `jre/includes/admin/class-jre-admin.php:44-54`, `jre/includes/admin/class-jre-admin-media-table.php` | admin | DROPPED | Texts → Gap 13; counts → PJ-48 run log; tags/area of focus dropped (Decision: taxonomy names) |
| Home page meta boxes (hero, boxes 1–6, content) and Organisations page "Promo Text" box | `jre/functions/home-page-meta-functions.php:32-268`, `wpo/includes/class-wpo-organisations-holder-page.php:116-160` | ON | COVERED | Blocks (Decision: home page; PJ-84/103) |
| Order admin: Activate / Complete / Pay / Fail / Refund / Reset; Xero invoice column; Xero settings page (account codes, branding theme, tracking) | `jr/includes/payments/admin/order-single.php:272-278`, `axi/includes/admin/class-axi-order-table-extensions.php`, `axi/includes/admin/class-axi-xero-settings.php:60-260` | ON | COVERED / GAP | PJ-23/55/59; "mark paid" = Gap 1 |
| Plan admin: job types on plans; per-plan resume-view limit (FXtender) | `jre/includes/class-jre-post-types.php:32-59`, `fx/includes/pro/features.php:3235-3270` | ON / UNUSED | COVERED / DROPPED | PJ-21; resume limits dropped (Decision 1) |
| Export User Data (`q_eud_exports` 2; in `composer.json`, not in the active list) | QR§12 | rare | DROPPED (proposed) | Site managers export with PJ-46/53 |
| Admin security (`jr_admin_security=edit_others_posts`) | QR§6 | ON | COVERED | Decision 3 (site managers use the Payload admin) |
| Analytics in admin | – (new) | – | COVERED | PJ-110 |

## 12. SEO, feeds, URLs

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Yoast sitemaps (12 child sitemaps, 28 live jobs missing) | CRAWL§1/§10 | ON | COVERED | PJ-40 (all live jobs) |
| robots.txt | CRAWL | ON | COVERED | PJ-40/104 |
| Yoast titles/descriptions on pages, primary category | QR§13 | ON | COVERED | Decision: GEO (one SEO tab), PJ-104 |
| Feeds: site, jobs, featured `?rss_featured=1`, per-category/type/salary (23), per-org (29), volunteer, paid/voluntary feed pages; item title + " - location", body prefixed with company, salary text and job type | CRAWL§6, `jre/includes/class-jre-rss-customisations.php:28-57`, `efate/includes/template-tags.php:549-563`, `efate/feeds/*.php` | ? | COVERED | Decision: RSS on hold (PJ-116); query 49 |
| `/resumes/feed/` + 200 CV pages + 176 CV taxonomy URLs (public) | CRAWL§4 | ON | GAP | Gap 3 |
| WP attachment pages (147) | CRAWL§5 | ON | GAP | Gap 11 |
| `?p=` shortlinks (50) | CRAWL§8 | ON | GAP | Gap 11 |
| `/wp/*`, `xmlrpc.php`, `wp-login.php` | CRAWL§3.1 | ON | COVERED | PJ-42 404 (proposed: 410 for /wp/*) |
| Trailing-slash duplicates, `/employer/` → `/employers/` | CRAWL§10 | ON | COVERED | PJ-42 |
| HTTP→HTTPS, apex/www | QR§29 | ON | COVERED | Cloudflare (PJ-74) |
| Organisation URLs `/organisation/{nickname}` (author base rewritten to `%author_level%` = organisation/author) | CRAWL§3.4, `jre/includes/class-jre-user-profile-extensions.php:568-640` | ON | COVERED | PJ-38/42 |
| Other legacy endpoints: `/confirm/?confirm=` and `?unsubscribe=`, `/resend-confirmation/`, `/invoice?id=`, `/xero-auth`, `?star=true` / `false`, `?job_relist=`, `?job_edit=`, `?job_end=…&confirm=1[&cancel=1]`, `?step=`, `?process-job-alerts=all` | `efate/includes/confirm.php`, `axi/includes/frontend/*.php`, `jr/includes/users.php:287`, `jr/includes/views.php:2140-2178`, `wja/wp-job-alerts.php:115-127` | ON | COVERED | Replaced by /account and admin actions; PJ-42 sends `/confirm/*`, `/invoice*` to /account, the rest 410 |
| llms.txt, AI crawlers | – (new) | – | COVERED | Decision: GEO (PJ-104) |

## 13. Scheduled tasks

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| WP-cron fired by page loads (no server cron) | QR§27 | – | COVERED | Cron Triggers (PJ-08) |
| Hourly `jr_check_jobs_expired`: expire jobs + 5-day / 1-day warnings | AUDIT, `jr/includes/cron.php:28-31`, `jr/includes/job-status.php:64-140` | ON | COVERED | PJ-52 |
| Daily `jr_prune_expired_featured`: remove expired featured add-ons | AUDIT, `jr/includes/cron.php:33-36` | ON | COVERED | PJ-87 (expire-job-placements) |
| Daily `md_daily_job_alerts` at 00:00 UTC + background-queue healthcheck (`wp_md_job_alerts_cron`) | AUDIT, `wja/wp-job-alerts.php:107-112`, `wja/includes/class-md-process-job-alerts.php` (WP Background Processing) | ON | COVERED | PJ-48 |
| Daily: clear daily view counts | AUDIT | ON | COVERED | PJ-37/110 (daily views in our own counter) |
| `jr_job_alerts` (theme), `app_order_processing`, `jr_check_expired_subscriptions`, `jr_check_packs_expired`, `daily_resume_reminder_email` (10:00 local, dead date), `appthemes_addons_mp_updates_check` | USAGE, `jr/includes/cron.php:38-67`, `aae/includes/tasks/class-aae-resume-reminder-emails-task.php:30-36`, `jr/includes/admin/addons-mp/load.php:234` | dead/dup | DROPPED | USAGE |
| UpdraftPlus daily | QR§27 | ON | COVERED | Decision: backups |
| Wordfence scans | plugin | ON | DROPPED | Decision: security |
| Full hook list | The rows above are every `wp_schedule_event` in efate, the called jobroller code and the custom plugins | – | – | Query 39 confirms what is actually scheduled in the DB |
| Retention jobs (applications, forms, email log) | – (new) | – | COVERED | PJ-88, PJ-102, PJ-50 |

## 14. Security and spam

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| reCAPTCHA (registration) + anti-spam question (guest apply) + honeypots (registration, contact) | QR§6, `efate/includes/forms/register/register-form.php:34-35,119-121`, `efate/includes/forms.php:512-519`, `jr/tpl-contact.php:45` | ON | COVERED | Decision: spam/bots |
| Spam accounts (disposable domains in the top 25) | QR§17 | ON | COVERED | Disposable-email block (Decision: spam/bots) |
| Wordfence firewall / 2FA | plugin, QR§12 | ON | COVERED | Decision: security (2FA post-MVP) |
| Hardcoded secrets (MailChimp key, Xero client ID, Google Maps key in `jr_options`) | AUDIT, USAGE | – | COVERED | PJ-75 (rotate; add the Maps key to the list) |
| `print_r($_POST)` debug leftover | AUDIT, `jre/includes/class-jre-taxonomies.php:52-55` | – | DROPPED | Not ported |
| SQL injection in `/confirm/?unsubscribe=` (value interpolated into SQL) | `efate/includes/confirm.php:95-97` | ON | DROPPED | Not ported; signed one-click unsubscribe tokens (Decision: alerts) |
| Unauthenticated AJAX: `jr_fx_load_company_logo`, `jr_fx_qtip_callback` (and FXtender re-fires any `wp_ajax_nopriv_*` from `$_REQUEST`) | `fx/includes/pro/features.php:45-46`, `fx/includes/features.php:34-42` | ON | DROPPED | Not ported; uploads only through authenticated endpoints |
| MySQL port 3306 open to the internet | QR§28 | – | COVERED | PJ-73/75 (close at decommission) |
| Public CV pages (personal data) | CRAWL§4 | ON | GAP | Gap 3 |

## 15. Settings in `jr_options` that change behaviour

| Setting = value | Effect | Status | Where |
|---|---|---|---|
| `jr_jobs_require_moderation` empty | no moderation | COVERED | Decision: moderation; 'trusted' |
| `jr_editing_needs_approval` empty | edits go live | COVERED | Deep sweep |
| `jr_allow_relist=1`, `jr_allow_editing=1` | relist/edit | COVERED | PJ-33 |
| `jr_jobs_default_expires=45` | max close date | COVERED | Decision: job duration |
| `jr_expired_action=hide` | expired hidden | COVERED (changed) | Decision 17 |
| `jr_jobs_charge=1` | paid posting | COVERED | PJ-31 |
| `jr_submit_cat_required=1`, `jr_submit_cat_editable=1` | category rules | GAP | Gap 15 |
| `jr_submit_how_to_apply_display=1`, `jr_enable_salary_field=1` | form fields shown | COVERED | PJ-19 |
| `jr_html_allowed` empty | restricted HTML | COVERED | Lexical |
| `jr_jobs_per_page=20` | paging | DROPPED | Decision 16 |
| `jr_featured_jobs_sort=newest` | featured order | COVERED | Decision: listing order |
| `jr_ad_stats_all=1` | public view stats (template tests `== 'yes'`) | GAP | Gap 7; query 56 |
| `jr_show_empty_categories` empty | hide empty | COVERED | Filter URLs decision |
| `jr_allow_job_seekers=1`, `jr_allow_recruiters` empty | roles | COVERED/OFF | Seekers kept; agencies |
| `jr_resume_*` (visibility listers, no subscription, no contact form) | resumes | DROPPED | Decision 1 |
| `jr_captcha_enable=1`, contact/application captcha `no`, antispam Q/A | spam | COVERED | Turnstile |
| `jr_enable_header_banner=1`, `jr_enable_listing_banner=1` | banners | COVERED | Header banner decision |
| `jr_enable_terms_conditions` empty | no T&C box | COVERED | PJ-89 |
| `jr_bcc_apply_emails=1` | admin copy | COVERED | Decision |
| `jr_new_job_email_owner=1`, `jr_expired_job_email_owner=1` (also gates the expiry reminders), `jr_nu_custom_email=1` (code wants 'yes') | emails | COVERED | Decision: email list; query 51 |
| `jr_nu_admin_email` empty → no admin copy of registrations; `jr_new_ad_email` empty → admin "new job" email IS sent (`'no' !=` test) | admin notices | OFF / COVERED | `aae/includes/emails/email-functions.php:44`, `aae/includes/class-aae-email-controller.php:78` |
| `jr_job_alerts=1`, cron daily, limit 5, batch 100, feed off | alerts | COVERED | PJ-48 |
| `jr_gmaps_lang=en`, `jr_gmaps_region=VU`, `jr_distance_unit=km` | server-side geocoding of the address; radius unused | DROPPED | No map/radius (§2, §4) |
| `apply_reg_users_only`, `allow_job_comments`, `plan_type`, `include_nowhere` (inside the serialised array) | apply rules, pack vs single plan form | ? | Query 56 |
| `jr_google_analytics` (UA) | dead tag | DROPPED | Analytics decision |
| `jr_indeed_*`, `jr_dynamic_search_results` empty | off | OFF | – |
| `jr_enable_log=1`, `jr_debug_mode` empty | logging | DROPPED | Workers Logs |
| `jr_remove_wp_generator=1`, `jr_remove_admin_bar=1` | WP-only | n/a | – |
| `tax_charge=0`; `axi_*` account codes, due 14 days | tax/Xero | COVERED | PJ-91, PJ-59 |
| Remaining ~110 `jr_*` options not yet listed | ? | – | Query 38 |

## 16. User meta / post meta written by the legacy site (import view)

| Meta | Count | Status |
|---|---|---|
| `last_login`, `confirmation_key` | 3,418 / 10,956 | COVERED (PJ-62 rule; keys not imported) |
| `_starred_jobs` | 240 | COVERED (PJ-66) |
| `_viewed_jobs` | 2,219 | DROPPED (localStorage, PJ-111) |
| `jr_alert*` | 551–982 | COVERED (PJ-66) |
| org fields, `can_pay_by_bank_transfer*`, `xero_contact_code`, `listing_request`, `enable_organisations_page` | see §5 | COVERED (PJ-62) |
| `_jr_user_packs_active`, `_jr_user_pack-*`, `_jr_user_plans_history` | 22 / 17 | COVERED (PJ-65 opening ledger rows) |
| seeker profile meta (361); `twitter_id`/`facebook_id`/`linkedin_profile` (541, orgs + seekers) | 361 / 541 | DROPPED for seekers; org values COVERED (PJ-62) |
| `opengraph_image_id` (292, last job's share image), `org_listing_email_sent` (35), `delete-logo` (30), `company-logo` (158), `profile_picture` (296), `area-of-focus` terms | QR§12 | COVERED (logo/cover → org, PJ-62) / DROPPED (rest, regenerated or UI-only) |
| `THANKSFROMYCV` | 4 | ? (query 46) |
| `wfls-last-login`, Yoast/admin UI meta | – | DROPPED |
| Job: `_how_to_apply`, recipient, apply-online flag, `_jr_address`/`geo_short_address`/`overseas_address`, `_jr_fx_expire_days`/`_jr_job_duration`, `_displayed_salary`, featured flags, counts, `_jr_job_application` | QR§13; written by `efate/includes/forms.php:1093-1112`, `fx/includes/pro/features.php:388-460`, `jre/includes/class-jre-job-submission-process.php:54-107` | COVERED (PJ-64) |
| Job: `_Company` / `_CompanyURL` | 6,395 | GAP (Gaps 4, 22) |
| Job: `_jr_geo_latitude`/`_jr_geo_longitude`, `geo_country`, `geo_short_address_country` | 6,117 | DROPPED (no map; geocoded town names) |
| Job: `_yoast_wpseo_opengraph-image` + sideloaded 1200×630 copy | 6,691 | DROPPED (PJ-105 regenerates) |
| Job: `_jr_expired_reason`, `_jr_canceled_job`: system codes (`user_ended`, `user_canceled`, …) set by end/cancel, not chosen by the employer (`jr/includes/job-status.php:311-329`) | 4,317 / 228 | COVERED (import as the job History event type, Decision: credits traceable) |
| Job: `_relisting` | 31 | COVERED (import as a History event) |
| Job: `user_IP` | 6,221 | DROPPED (PJ-64) |
| Job: `_jr_days_expire_reminder_email_sent` | 4,184 | DROPPED (expired jobs don't need it; live jobs: PJ-52 sends at most once) |

## 17. AJAX handlers, endpoints and REST (from the code)

No REST routes are registered by efate or the custom plugins (`register_rest_route` appears only in vendor code). Every admin-ajax action reachable on vwok:

| Action | Who | Where | Status | Decision / proposed default |
|---|---|---|---|---|
| `app-render-job-form` (category custom fields) | signed-in | `jr/includes/custom-forms.php:5,25-35`; JS loader defined but never bound (`efate/_dev/js/modules/job-submit-form.js:183-194`) | UNUSED in practice | Gap 8 |
| `jr_fx_load_company_logo` (logo upload on the posting form; also `nopriv`) | employer | `fx/includes/pro/features.php:45-46,2156-2180` | ON | COVERED (org logo upload in /account, PJ-18/82) |
| `jr_fx_get_job_applications`, `jr_fx_handle_linkedin_job_applications` | employer / admin | `fx/includes/pro/features.php:51-52,2346-2365,2950-2970` | ON / OFF | COVERED (PJ-46/82); LinkedIn DROPPED |
| `jr_fx_qtip_callback` (hover job preview on listings; also `nopriv`) | public | `fx/includes/features.php:34-42,294-380` | ? (query 50) | DROPPED (proposed: no hover previews, PageSpeed) |
| `{ptype}_geocode_{field}_field` (address geocoding) | signed-in | `efate/includes/geolocation.php:253,568-588` | ON (server-side) | DROPPED (location tree) |
| `reset-stats` (job view counters) | admin | `jr/includes/stats/stats.php:31` | admin | DROPPED |
| `reset-order`, `activate-order`, `pay-order`, `complete-order`, `fail-order`, `refund-order`, `reset-gateway` | admin | `jr/includes/payments/admin/order-single.php:272-278` | ON | COVERED / Gap 1 (mark paid) |
| checkout progress (`wp_ajax_{checkout_type}`, also `nopriv`) | buyer | `jr/includes/checkout/progress/class-progress-ajax-view.php:16-17` | ON | COVERED (PJ-82 server-rendered steps) |
| `get_indeed_results`, `app_check_geocoder` | public / admin | `jr/includes/indeed/indeed.php:109-110`, `jr/includes/geo/admin/settings.php:37` | OFF | OFF |

## 18. Front-end JS widgets, cookies and browser storage (from `efate/_dev`)

`efate/_dev/Gruntfile.js` concatenates `js/*.js`, `js/modules/*.js` and `js/third-party/*.js` into `island.js` (jQuery, jQuery Validate, jQuery UI sortable). The theme writes **no cookies and no localStorage/sessionStorage**; the only cookies are WordPress's own login cookies.

| Widget | Where | Used? | Status | Decision / proposed default |
|---|---|---|---|---|
| Location search combobox (jQuery UI autocomplete over a fixed list; capitalises typed text) | `efate/_dev/js/third-party/jquery.ui.combobox.js`, `efate/_dev/js/modules/sitewide-functions.js:9-29` | ON | COVERED | Native `<select>`/link list from the location tree (PJ-36/99), no JS |
| Island → Town dependent selects + "Multiple Locations?" toggle + saved-address restore | `efate/_dev/js/modules/location-selector-functions.js`, `efate/_dev/js/modules/regions-and-towns.js` | ON | COVERED / GAP | PJ-99 picker; multi-location = Gap 2 |
| Close-date picker (Pikaday) writing a days field | `efate/_dev/js/modules/job-submit-form.js:19-57`, `efate/_dev/js/third-party/pikaday.js` | ON | COVERED | Native `<input type="date">` with min/max (Decision: job duration) |
| Volunteer type → salary "Voluntary" auto-select | `efate/_dev/js/modules/job-submit-form.js:69-85` | ON | GAP | Gap 19 |
| Apply-online toggle hides the applications email | `efate/_dev/js/modules/job-submit-form.js:87-103` | ON | COVERED | PJ-82 (CSS-only or server-side) |
| Form validation + submit spinner | `efate/_dev/js/modules/job-submit-form.js:132-181`, `efate/_dev/js/modules/sitewide-functions.js:61-99` | ON | COVERED | Server validation + native `required` (PJ-82) |
| Register form: hide company name for seekers | `efate/_dev/js/modules/register-form.js` | ON | COVERED | PJ-29 |
| Seeker alert categories: expand/collapse parent categories | `efate/_dev/js/modules/job-seeker-dashboard-functions.js` | ON | COVERED | Flat categories (Decision: filter URLs) |
| Organisation directory filters (client-side show/hide) | `efate/_dev/js/modules/organisations-page.js` | ON | COVERED | PJ-38 |
| Home hero height on resize; lazy-load images | `efate/_dev/js/modules/homepage-functions.js` | ON | DROPPED | CSS only (PageSpeed 100) |
| Mobile slide-in menu | `efate/_dev/js/modules/sitewide-functions.js:31-59` | ON | COVERED | PJ-103 |
| Delete-account form reveal ("Delete Me") | `efate/_dev/js/modules/delete-account-form.js` | OFF | DROPPED | Decision: account deletion |
| Profile cover image picker (WP media modal) | `efate/assets/js/frontend-image-uploader.js` (enqueued on `tpl-profile.php`, `efate/classes/style-and-script-controller.php:83-98`) | ON | COVERED | Plain file upload in /account (PJ-18) |
| FXtender injected fields (job duration, disable apply, applications email) and listing thumbs / days-left / qTip previews | `fx/includes/jscripts.php:255-660` | ON / ? | COVERED / query 50 | Server-rendered fields in PJ-82 |

## 19. Generic plugins: how vwok uses them

| Plugin | Use on vwok | Status | Decision |
|---|---|---|---|
| wordpress-seo (Yoast) | Titles/descriptions, sitemaps, JobPosting/OG; org OG image via `wpseo_opengraph_image` (`jre/includes/class-jre-user-profile-extensions.php:42`); per-job OG image meta | ON | COVERED (Decision: GEO, PJ-40/104/105) |
| post-smtp | Gmail OAuth2 transport, sent-mail log | ON | COVERED (Decision: email transport per tenant; PJ-50) |
| wordfence | Firewall, scans, login 2FA | ON | DROPPED (Decision: security) |
| cloudflare | Cache purge on edit | ON | COVERED (PJ-41) |
| updraftplus | Daily backups | ON | COVERED (Decision: backups) |
| wp-crontrol | Cron UI for admins | admin | COVERED (run log + heartbeat) |
| classic-editor | Disables the block editor for pages/jobs | ON | n/a (Lexical) |
| search-and-replace | Admin DB tool | admin | DROPPED |
| user-switching | "Switch to" in the users list; no custom code | ? | GAP (Gap 9) |
| registration-honeypot | `th_rh_name` field on the register form | ON | COVERED (Turnstile + honeypot, PJ-29) |
| multi-image-metabox | Installed, no template or plugin reads it | UNUSED | DROPPED |
