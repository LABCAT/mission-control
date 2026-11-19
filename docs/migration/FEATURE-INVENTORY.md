# vanuatuwok.vu – feature inventory vs new-site decisions (19 Nov 2026)

Every behaviour of the live WordPress/JobRoller site that we could find evidence for, checked against the binding decisions (`STATUS.md` "Decision …" lines, where the later one wins), `PROPOSAL-ROLES.md`, `TICKET-CLEANUP-19NOV.md` and the D1 `PJ-*` tickets.

**Status values:** COVERED (a decision or ticket is cited) · DROPPED (a decision drops it) · OFF/UNUSED (a setting or data shows it isn't used) · GAP (no decision yet; a proposed default is given).

**Proposed defaults follow the founder's principles.** Legacy parity by default. Every business rule is a per-tenant setting that defaults to vwok's current behaviour. Simplest option. No deprecated legacy logic. Low cost. PageSpeed 100.

## ⚠ Limitation: the legacy code was not walked in this pass

The brief asked for a file-by-file walk of `LABCAT/vanuatuwok.vu` (`migration-plan`: efate, jobroller and the active plugins). **This session could not attach that repo.** `add_repo` was refused by the permission classifier, and an unauthenticated clone gets no credentials. Every row below therefore comes from evidence that is already in this repo:

| Source | Abbrev. |
|---|---|
| `AUDIT.md`: the Oct 2026 code audit of the same legacy repo | AUDIT |
| `QUERY-RESULTS-19NOV.md`: live DB and `jr_options`, section n | QR§n |
| `USAGE.md`: live usage, 22 Oct | USAGE |
| `docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md`: public crawl, section n | CRAWL§n |
| `STATUS.md` decision lines | "Decision: …" |
| D1 ticket prompts | PJ-nn |

Rows marked **[code]** still need a file:line check once the repo is attached: form field lists, AJAX handlers, front-end JS in `efate/_dev`, and the exact email triggers. Queries 37–48 (below) settle the rest from the DB.

---

## GAPS needing the founder (most important first)

1. **Code walk blocked.** Allow `add_repo` for LABCAT/vanuatuwok.vu, or run this pass in a session that has it. Without it, the [code] rows (posting-form fields, AJAX, JS widgets) are unconfirmed. *Default: rerun the walk before PJ-82 (posting form) is dispatched.*
2. **"Order paid": no defined trigger.** Legacy never marks bank-transfer orders paid (`ACTIVATE_INVOICES` undefined; 5,902 `tr_pending`). The new email list has "order paid", and untrusted jobs wait "usually after first invoice paid". *Default: a site manager marks the order paid in the admin (it sends the email and releases the job). Xero payment sync is post-MVP.*
3. **Multiple locations per job** ("Multiple Locations?" checkbox; addresses like "Port Vila, Santo and Tanna"). *Default: job → locations has-many (PJ-99), one location by default. Waits for query 36.*
4. **CV/resume module still in live use** (201 public + 325 private resumes, the newest 4 Nov 2026; `/resumes/*`, 176 CV taxonomy URLs and `/resumes/feed/` are publicly reachable). Decision 1 drops it. What's open is the URLs and the data. *Default: `/resumes/*` returns 410 and is kept out of the redirect map; resumes and `uploaded_cvs` are not imported and are destroyed with the server at decommission (data deletion = founder).*
5. **Job map / lat-lng** (6,117 jobs have coordinates). *Default: import lat/lng, no map in the MVP (waits for query 35).*
6. **Public view counter on job pages** (`jr_ad_stats_all = 1`: "N views, M today" shown to everyone). *Default: off, because cached HTML can't show live counts. Employers see views in /account (PJ-110). Per-tenant setting.*
7. **End-early / expiry reason** (`_jr_expired_reason` on 4,317 jobs, `_jr_canceled_job` on 228). *Default: an optional reason picker on "end early", logged in job History. Legacy values imported. Query 41 lists the values.*
8. **"Log in as user"** (User Switching plugin is active). *Default: none in the MVP. Site managers edit on the user's behalf in the admin.*
9. **Legacy search query URLs** (`/jobs/?s=`, `?location=`, `?full-time=show&action=Filter`, `/job-date-archive/?time=week&jobs_by_date=1`). *Default: 301 each to the new filter URL (PJ-42 table), unknown params dropped per the junk-URL rule.*
10. **WP attachment pages and `?p=` shortlinks** (147 attachment pages, 50 shortlinks). *Default: attachment page → 301 to the imported R2 file, else 410; `?p=ID` → 301 to the new URL (PJ-42).*
11. **Overseas / remote jobs** ("Overseas" picker entry; "Anywhere/Work From Home"). *Default: seed "Overseas" (already in PJ-17) and "Remote / anywhere" as top-level locations.*
12. **Submit-page intro text** (`jr_jobs_submit_text`: "Job listings start from Vt 4,000…", but the cheapest plan is 3,900). *Default: a rich-text intro in site settings shown on the posting form. The new copy comes from the Plans block.*
13. **Legacy page content of unknown purpose:** "Sign-up to our Email" (/sign-up), "Application form" (2019), "Job email text", `custom-form` post (2018). *Default: not imported, 301 /sign-up → alert sign-up. Query 37 confirms.*
14. **Admin copy of new registrations** (AUDIT lists it; `jr_nu_admin_email` is empty). *Default: off. Per-tenant toggle only if the code shows Advanced Emails sends it.*
15. **Category required and editable after posting** (`jr_submit_cat_required = 1`, `jr_submit_cat_editable = 1`). *Default: parity (required, editable) as per-tenant settings in PJ-82.*
16. **Volunteer-specific "job approved" email.** *Default: one "job live" template with a job-type variable and a conditional line. No second template.*
17. **Organisation SEO fields** (Yoast `wpseo_title`/`wpseo_metadesc` on 88 org users). *Default: import into the org SEO tab (PJ-62/104).*
18. **Employer contact fields** (`phone_number`/`area_code`/`job_title` on 255 users, `physical_location` on 145). *Default: phone and location go onto the organisation (PJ-18 has phone and location). Contact job title is dropped. Query 43 confirms.*
19. **Sign-in return URL** (legacy `/login/?redirect_to=…&role=…`). *Default: every sign-in link carries a return URL. The role hint is dropped (one sign-in).*
20. **Radius search** (`jr_distance_unit = km`, geocoder). *Default: dropped, because locations are a tree (PJ-99). [code] confirm that radius was visible in the UI.*
21. **Alert send time** (legacy run logged at 11:00 Vanuatu time = 00:00 UTC). *Default: per-tenant send hour, vwok 00:00 UTC (PJ-48).*

## Queries added (QUERIES-19NOV.sql)

37 shortcodes/forms on published pages · 38 remaining `jr_*` options · 39 WP-cron hook names · 40 application attachments (CV/cover letter) · 41 expiry/cancel reasons · 42 pending and draft jobs by year and type · 43 employer contact fields on active users · 44 resumes by year · 45 Wordfence 2FA users · 46 `THANKSFROMYCV` meta · 47 Overseas/remote job addresses · 48 recent use of featured-category.

---

## 1. Public site (layout, pages, navigation)

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Header banner (desktop) + listing banner (320×50 mobile) → ycv.vu | QR§6 `jr_enable_header_banner=1`, `jr_enable_listing_banner=1` | ON | COVERED | Decision: header banner (PJ-84/67) |
| Logo from settings | QR§6 `jr_use_logo=yes`, `jr_logo_url` | ON | COVERED | PJ-20 site settings |
| Main menu: Jobs, Volunteering, For Employers, Organisations, About us; Top: Contact; Bottom: Powered by YCV, Password Reset, Submit Job, Login | QR§26 | ON | COVERED | PJ-103 menus, PJ-67 import |
| Home page: hero + search, 3 feature boxes, latest jobs (featured first), rich text (meta boxes via multi-image-metabox) | AUDIT "Home page", STATUS | ON | COVERED | Decision: home page (PJ-39/84/103) |
| Sidebar / search bar / filter bar shown | QR§6 `jr_show_sidebar/searchbar/filterbar=1` | ON | COVERED | Decision: listing filters (PJ-36) |
| Breadcrumbs | `jr_options` `breadcrumbs b:1` (QR§3) | ON | COVERED | Decision: job URLs (breadcrumbs + JSON-LD), PJ-104 |
| Pages: About us, Contact (contact-2), For Employers, Organisations, Volunteering, T&C | QR§9, CRAWL§3.1 | ON | COVERED | PJ-67/103, PJ-89 (T&C) |
| Land Law Reforms, Organisation Competition | QR§9 | stale | DROPPED | Decision: not imported → 410 |
| Contact page: form + Google map | QR§7, Decision | ON | COVERED | Decision: contact page (PJ-102) |
| Captcha on contact forms | QR§6 `jr_captcha_contact_forms_enable=no` | OFF | COVERED | Decision: spam/bots (Turnstile everywhere) |
| Blog | QR§8 (0 posts, 1 draft), `jr_disable_blog` empty | UNUSED | DROPPED | Import scope 1 |
| Comments | QR§16 (table empty) | UNUSED | DROPPED | Import scope |
| JobRoller system pages (Dashboard, My Profile, Edit Job, Submit, Login, Register, Password Recovery/Reset, Confirm, Resend, Purchase Job Pack) | QR§9 | ON | COVERED | Replaced by /account (Decision 2, PJ-82/83/109); 301s in PJ-42 |
| Purchase Resume Subscription, Resumes restricted, Edit Resume | QR§9 | — | DROPPED | Decision 1 |
| "Sign-up to our Email" /sign-up, "Application form", "Job email text", `custom-form` post | QR§8/§9, CRAWL§3.6 | unknown | GAP | Gap 13; query 37 |
| A5 Vanuatu Wok booklet PDF (linked) | CRAWL§7 | ON | COVERED | PJ-63 (referenced files imported) |
| Google Analytics (UA tag via `jr_google_analytics`) | QR§18 | dead | DROPPED | Decision: analytics (Cloudflare Web Analytics) |
| Facebook / Twitter / ShareThis IDs, Feedburner | QR§6 (empty) | OFF | OFF | – |
| Indeed job feed integration | QR§6 `jr_indeed_publisher_id` empty, `jr_indeed_front_page` empty | OFF | OFF | – |
| Footer: "Powered by Youth Challenge Vanuatu" | QR§26 | ON | COVERED | PJ-103 menus |
| English only | Decision | – | COVERED | Decision: English only |
| Recently viewed jobs / "Viewed" label (`_viewed_jobs` meta on 2,219 users) | QR§12 | ON | COVERED | Decision: viewed jobs (localStorage, PJ-111); server meta not imported |
| Saved / starred jobs (`_starred_jobs` on 240 users) | QR§12 | ON | COVERED | Decision: saved jobs (PJ-83/66) |
| Print job (`window.print()`) | CRAWL§3.3 | ON | COVERED (implied) | Print stylesheet on the job page, no JS (PJ-37 note) |
| AddThis share buttons | CRAWL§3.3 | broken (AddThis shut down 2023) | DROPPED | Share images make manual sharing look good (Decision: share images, PJ-105) |
| Accessibility | – | – | COVERED | Decision: accessibility (WCAG 2.2 AA) |

## 2. Search, listings and filters

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Keyword search `?s=` | CRAWL§9 | ON | COVERED | Decision: search (Postgres FTS), PJ-36 |
| Location search `?location=` (free text, geocoded) | CRAWL§9, AUDIT | ON | COVERED | Decision: filter URLs /jobs/{location} (PJ-36/99) |
| Radius search (`jr_distance_unit=km`) | QR§6 | unknown [code] | GAP | Gap 20 (drop) |
| Job-type checkboxes `?{type}=show&action=Filter` | CRAWL§9 | ON | COVERED | Decision: listing filters + /jobs/{type} |
| Category / type / salary taxonomy pages `/job-category/…`, `/job-type/…`, `/job-salary/…` | CRAWL§3.5, QR§19 permalinks | ON | COVERED | Decision: filter URLs; 301 map PJ-42 |
| Salary band filter | `jr_enable_salary_field=1` | ON | COVERED | Decision: listing filters |
| Job date archive (today / week / last week / month) | CRAWL§3.1/§9 | ON | COVERED | "Date posted" filter (Decision: listing filters); 301 in Gap 9 |
| Legacy query URLs → new URLs | CRAWL§9 | ON | GAP | Gap 9 |
| 20 jobs per page + pagination `/jobs/page/N/` | QR§6 `jr_jobs_per_page=20`, CRAWL§3.2 | ON | DROPPED | Decision 16 (no pagination); `/page/N` → 301 to /jobs |
| Featured block above the list, newest first | `jr_featured_jobs_sort=newest` | ON | COVERED | Decision: listing order |
| Featured in category | QR§13 (62 jobs ever) | rare | DROPPED (vwok) | Decision: listing order |
| Volunteer jobs listed separately (/volunteer-jobs) | AUDIT, QR§9 | ON | COVERED | Decision: job type pages ('listed separately') |
| Expired jobs hidden (`jr_expired_action=hide`) | QR§3 | ON | COVERED (changed) | Decision 17 + "expired jobs (confirmed)" |
| Empty categories hidden (`jr_show_empty_categories` empty) | QR§6 | ON | COVERED | Decision: filter URLs (empty pages noindex, not in sitemap) |
| Dynamic (AJAX) search results | `jr_dynamic_search_results` empty | OFF | OFF | – |
| Organisation directory filters (type, size) + live job count | AUDIT, CRAWL§9 | ON | COVERED | PJ-38 (area of focus dropped) |

## 3. Job posting form (employer)

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Multi-step submit (details → plan → preview → pay), drafts (486 drafts) | QR§8, AUDIT | ON | COVERED | Decision: job description editor (multi-step + drafts), PJ-82 |
| Title, description (TinyMCE; `jr_html_allowed` empty) | AUDIT | ON | COVERED | Decision: Lexical editor |
| Category (required, editable later) | `jr_submit_cat_required=1`, `jr_submit_cat_editable=1` | ON | GAP | Gap 15 |
| Job type, salary band, displayed salary text (3,100 jobs) | QR§13 | ON | COVERED | Decision: salary + job type clean-up; PJ-19/64 |
| Company name + URL (`_Company`, `_CompanyURL`) | QR§13 (6,395) | ON | COVERED | PJ-19/64; agencies decision for "post for client" |
| How to apply (text) | QR§13, `jr_submit_how_to_apply_display=1` | ON | COVERED | PJ-19/64 |
| Per-job application email (`jr_fx_apps_recipient_address`) | QR§13 (6,391) | ON | COVERED | PJ-19 `applicationsRecipient` |
| Apply online on/off (`jr_fx_disable_apply_online`) | QR§13 (6,248) | ON | COVERED | Decision: apply form (per-job switch) |
| Location: Island/Town picker + "Overseas" + hidden lat/lng | AUDIT, PJ-17 (regions-and-towns.js) | ON | COVERED | PJ-17/99 |
| "Multiple Locations?" checkbox | STATUS 'Pending proof' | ON? | GAP | Gap 3, query 36 |
| Close date picker (max 45 days, `_jr_fx_expire_days`) | QR§13 (6,191), `jr_jobs_default_expires=45` | ON | COVERED | Decision: job duration (close date, plan max) |
| Job description PDF upload (1,104 PDFs) | QR§33, USAGE | ON | COVERED | Deep sweep (PJ-82) |
| Logo shown on every job (`jr_fx_opt_jobs_lister_persistent_logo_gravatar=yes`) | QR§19 | ON | COVERED | Org logo on job (PJ-37) |
| Terms checkbox on submit (`jr_enable_terms_conditions` empty) | QR§6 | OFF | COVERED | PJ-89 consent lines |
| Intro text on submit page (`jr_jobs_submit_text`) | QR§6 | ON | GAP | Gap 12 |
| Edit live job, no re-approval (`jr_allow_editing=1`, `jr_editing_needs_approval` empty) | QR§6 | ON | COVERED | Deep sweep decision |
| Job tags (`job_tag`) | QR§10 (no terms) | UNUSED | DROPPED | Decision: taxonomy names |
| Agency "post for client / confidential" | – (new) | – | COVERED | Decision: agencies |
| Remaining form fields, validation, AJAX | – | [code] | GAP | Gap 1 |

## 4. Job page

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Flat URL `/jobs/{slug}` | CRAWL§3.3 | ON | COVERED | Decision: job URLs |
| Title, type, org, location, salary, category, description, PDF link | CRAWL§3.3 | ON | COVERED | PJ-37 |
| Inline apply form | CRAWL§3.3 | ON | COVERED | PJ-45 |
| View counter (total + daily; `jr_daily_count`, `jr_total_count`, 9.29M views) | QR§13/§14 | ON | COVERED | PJ-37 view beacon, PJ-64 import, PJ-110 |
| View counts shown publicly (`jr_ad_stats_all=1`) | QR§6 | ON | GAP | Gap 6 |
| Map ("View map") | 6,117 jobs with lat/lng | unproven | GAP | Gap 5, query 35 |
| JobPosting structured data (Yoast + theme) | AUDIT | ON | COVERED | PJ-37/104 |
| Yoast OG image per job (6,691) / 1200×630 generated image | QR§13, AUDIT | ON | COVERED | PJ-105 (regenerated, not imported) |
| Expired job URL behaviour | QR§3 hide → 404 today | – | COVERED | Decision 17 (200 + banner, 410 after 12 months) |
| Print, share | CRAWL§3.3 | – | see §1 | – |
| Similar jobs | – (new, for expired) | – | COVERED | Decision 17 |

## 5. Organisations

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Org = lister user + meta (name in `nickname`) | AUDIT | ON | COVERED | PJ-18 (real organisation), PROPOSAL-ROLES |
| Fields: type (296), size (273), logo (`company-logo` 158), cover (`profile_picture` 296), about, socials (facebook/twitter 86; instagram/linkedin/youtube/… 55) | QR§12 | ON | COVERED | PJ-18 (type, size, logo, cover, website, socials, phone, location, about) |
| Myspace, Google+, Soundcloud, Tumblr, Wikipedia, Pinterest links | QR§12 (55/36) | dead networks | DROPPED (proposed) | Import only live networks; mention in PJ-62 |
| Area of focus | QR§10 (no terms) | UNUSED | DROPPED | Decision: taxonomy names |
| Phone / area code / contact job title / physical location | QR§12 (255/145) | ? | GAP | Gap 18, query 43 |
| Public page `/organisation/{nickname}` | CRAWL§3.4 | ON | COVERED | PJ-38; 301 in PJ-42 |
| Page approval: listing request → admin enables → "now live" email (`listing_request` 27 open, `enable_organisations_page` 32 on, `org_listing_email_sent` 35) | QR§12/§15 | ON | COVERED | Decision: organisation pages approval |
| Directory with count of current jobs | AUDIT | ON | COVERED | PJ-38 |
| Org RSS feed (29) | CRAWL§6 | ? | COVERED | Decision: RSS (PJ-116 hold) |
| Org email on page (Cloudflare-obfuscated) | CRAWL§3.4 | ON | COVERED (implied) | PJ-38; no address in cached HTML beyond what the owner publishes |
| Yoast SEO title/description per org (88) | QR§12 | ON | GAP | Gap 17 |
| Multiple users per org / invites | AUDIT (none) | – | COVERED (new) | PROPOSAL-ROLES; PJ-29 |
| Deleted employer → jobs reassigned to `archive` user | AUDIT | ON | COVERED | Jobs belong to the org; Decision: account deletion (PJ-89) |
| "Trusted" (invoice-me, publish before payment) (`can_pay_by_bank_transfer` 79 + billing email 71) | QR§15 | ON | COVERED | Decision: one 'trusted' switch |
| `_approved_job_lister` (29) | QR§12 | ON | COVERED | Superseded by 'trusted' |
| Xero contact code (71) | QR§12 | ON | COVERED | PJ-62/56 |

## 6. Accounts, registration, sign-in

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Register: role (seeker/employer), first name, org name, username, email, password, honeypot | AUDIT | ON | COVERED | PJ-29 (user + org together), Decision: sign-in |
| reCAPTCHA at registration (`jr_captcha_enable=1`) + anti-spam question ("Is fire hot or cold?") | QR§6 | ON | COVERED | Decision: spam/bots (Turnstile + disposable-email block) |
| Registration Honeypot plugin | active plugins | ON | COVERED | PJ-29 |
| Email confirmation `/confirm/?confirm=KEY`, resend, admin manual confirm (`confirmation_key` 10,956) | AUDIT, QR§12 | ON | COVERED | Email code/link verifies (PJ-109); no manual confirm needed |
| Username sign-in | AUDIT | ON | COVERED | Deep sweep: email only; username kept for reference |
| Password reset / recovery | QR§9 | ON | COVERED | PJ-109 |
| WP password hashes | – | ON | COVERED | PJ-34 |
| `last_login` tracking (3,418) | QR§12 | ON | COVERED | PJ-62 migration rule |
| Login return URL `redirect_to` | CRAWL§3.6 | ON | GAP | Gap 19 |
| Recruiter role (`jr_allow_recruiters` empty) | QR§6 | OFF | OFF | Agencies decision covers it |
| Seekers allowed (`jr_allow_job_seekers=1`) | QR§6 | ON | COVERED | Decision: seeker accounts kept |
| Seeker profile (career status, availability, keywords, relocate/travel: 361; socials 541) | QR§12 | ON | DROPPED | Decision: no seeker profiles |
| Admin bar hidden for non-admins | `jr_remove_admin_bar=1` | ON | COVERED | n/a: /account is separate from admin (Decision 2) |
| Media library: users see only their own uploads | AUDIT | ON | COVERED | Access rules (PJ-10/18) |
| Account self-deletion ("Delete Me" JS, plugin missing) | AUDIT | OFF | DROPPED | Decision: account deletion |
| MailChimp subscribe at registration | Import scope | OFF | DROPPED | Import scope (revoke key, PJ-75) |
| Sessions | – | – | COVERED | Decision: sessions (keep me signed in) |
| Log in as user (User Switching) | active plugins | ? | GAP | Gap 8 |
| 2FA (Wordfence login security; `wfls-last-login` 2,570) | QR§12 | ? | COVERED | Decision: security (post-MVP); query 45 |
| Admin/editor roles (4 admins, 1 editor, 1 contributor) | QR§31 | ON | COVERED | PROPOSAL-ROLES (site manager) |

## 7. Applications

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Apply form: name, email, message, CV, cover letter, anti-spam question | CRAWL§3.3, AUDIT | ON | COVERED | Decision: apply form (CV now required; cover letter optional, PJ-45) |
| Captcha on apply (`jr_captcha_application_form_enable=no`) | QR§6 | OFF | COVERED | Turnstile (PJ-45) |
| LinkedIn apply (fxtender) | AUDIT | ? | DROPPED | Decision: apply form (post-MVP) |
| Guest apply (only signed-in applicants recorded) | STATUS notes | ON | COVERED | Decision: apply form ('account required' off) |
| Email to employer / per-job recipient; copy to applicant; BCC admin (`jr_bcc_apply_emails=1`) | QR§6 | ON | COVERED | Decision: admin copy of applications |
| Applications stored + both dashboards + CSV | AUDIT, QR§13 (`_jr_job_application` 415) | ON | COVERED | PJ-25/46/82/83 |
| Past applications/CVs | – | – | DROPPED | Decision 1 |
| Retention | – | – | COVERED | Decision 18 (PJ-88) |
| Attachment use (cover letters really sent?) | – | ? | – | Query 40 (informational) |

## 8. Job alerts

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Subscription: keywords, locations, types, categories, active/inactive (248 active / 312 inactive) | QR§12/§24 | ON | COVERED | Decision: job alerts (Indeed-style), PJ-47/66 |
| Daily, max 5 jobs per email, batch 100 | QR§6 `jr_job_alerts_*` | ON | COVERED | PJ-48 (vwok 5) |
| Run time: midnight UTC (log entries at 11:00 VUT) | QR§8 job-alerts-log latest 11:00:03 | ON | GAP | Gap 21 |
| Unsubscribe link / dashboard settings | QR§6 email body | ON | COVERED | Decision: alerts (one-click unsubscribe) |
| Alert email template (`%joblist%`, per-job line) | QR§6 | ON | COVERED | PJ-27/50 seed |
| Per-user alert RSS feed (`jr_alert_feed_key` 982; `jr_job_alerts_feed` empty) | QR§6/§12 | OFF | OFF | – |
| Run log (`job-alerts-log` 2,110) | QR§8 | ON | COVERED | PJ-48 run log |
| Duplicate theme cron `jr_job_alerts` | USAGE | ? | DROPPED | USAGE |
| Guest alerts / double opt-in / weekly | – (new) | – | COVERED | Decision: job alerts |

## 9. Commerce: plans, packs, coupons, orders, invoices, Xero

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Plans: Basic 3,900; Enhanced 5,900 (featured 30 d); 5-pack 17,500; 10-pack 33,000; Volunteer free | QR§1 | ON | COVERED | Decision 11/12, PJ-21/87 |
| Plan restricted to categories/types; new categories auto-added | AUDIT | ON | COVERED | PJ-21 (unrestricted = all) |
| Relist price (= price) | QR§1 | ON | COVERED | Decision: relisting |
| Charging on (`jr_jobs_charge=1`) | QR§6 | ON | COVERED | PJ-31 |
| Job packs / credits never expire (`_jr_user_packs_active` 22) | QR§1/§12 | ON | COVERED | Decision: credits (PJ-24/65) |
| Pack expiry cron `jr_check_packs_expired` | USAGE | no handler | DROPPED | USAGE |
| Coupons (LINKPS 1,900 off, 501 uses) | QR§5 | ON | COVERED | PJ-22/65 |
| Gateways: bank transfer / Invoice Me (100% of orders) | USAGE | ON | COVERED | Decision: payments (invoice only) |
| PayPal, 2Checkout, Authorize.net, Google Wallet; recurring `app_order_processing` | USAGE | UNUSED | DROPPED | Decision: payments |
| Orders `transaction` (5,902 pending, 66 failed, 40 activated) | QR§8 | ON | COVERED | PJ-23/65 (pending → invoiced) |
| Order marked paid | AUDIT (never auto) | – | GAP | Gap 2 |
| Currency Vatu, 0 decimals | AUDIT | ON | COVERED | PJ-21 |
| Tax (`tax_charge=0`) | QR§19 | OFF | COVERED | PJ-91 |
| Resume-access plans | USAGE | UNUSED | DROPPED | Decision 1 |
| "Unlimited 6 month" pending plan | QR§8 | not sold | DROPPED | Decision 11 |
| Xero OAuth connect `/xero-auth` | AUDIT | ON | COVERED | PJ-55 |
| Contact find/create `AXI-{id}` or override code | AUDIT | ON | COVERED | PJ-56 |
| Draft → authorised invoice; lines per plan/add-on/coupon; account codes 225/226/227; due 14 days; tracking none | QR§19 | ON | COVERED | PJ-57/59 |
| Payment recorded in Xero (not for Invoice Me) | AUDIT | OFF in practice | COVERED | No card gateway (Decision: payments) |
| `/invoice?id=` → Xero online invoice / HTML fallback | AUDIT | ON | COVERED | PJ-58 |
| Billing email cc'd on invoices | QR§12 (71) | ON | COVERED | Decision: invoice parity / 'trusted' |
| Xero step log (`order-log` 6,053) | QR§8 | ON | COVERED | PJ-57 (retry job; confirm it logs) |
| Member purchase rights | – (new) | – | COVERED | Decision: member purchase rights |

## 10. Emails

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Admin-editable subject/body/from (Advanced Emails "Custom Emails") | AUDIT, QR§3 `_custom_*` | ON | COVERED | Decision: email templates (final), PJ-27/50 |
| New user confirm (`jr_nu_custom_email=1`, text/plain) | QR§6 | ON | COVERED | Decision: email list |
| Admin copy of new user | AUDIT vs `jr_nu_admin_email` empty | ? | GAP | Gap 14 |
| New job → admin (`jr_new_ad_email` empty, Advanced Emails may send) | QR§6, AUDIT | ? [code] | COVERED | Decision: email list (job submitted admin+employer) |
| Job submitted/live → owner (`jr_new_job_email_owner=1`) | QR§6 | ON | COVERED | Decision: one email per action |
| Approved (paid / volunteer variants) | AUDIT | ON | GAP | Gap 16 |
| Expiring in 3 days (`_jr_days_expire_reminder_email_sent` 4,184) | QR§13 | ON | COVERED | PJ-52 |
| Expired + feedback text (`jr_expired_job_email_owner=1`) | QR§3 | ON | COVERED | PJ-52, seed text PJ-27 |
| Order created / paid / cancelled | AUDIT | ON | COVERED | Decision: email list |
| Application emails ×3 | AUDIT | ON | COVERED | Decision: email list |
| Org listing request → admin; page live → owner | AUDIT | ON | COVERED | Decision: email list |
| Resume subscription start/end; contact resume author; resume reminder | QR§3/§19, USAGE | OFF/dead | DROPPED | Decision: email list |
| Contact form email | QR§7 | ON | COVERED | PJ-102 |
| Alerts digest | QR§6 | ON | COVERED | PJ-48 |
| Transport: Post SMTP → Gmail OAuth2 (ycv.vu); log `postman_sent_mail` | QR§21, QR§8 | ON | COVERED | Decision: email transport per tenant (PJ-112); email log PJ-50 |
| SPF/DMARC for sending domain | QR§34 | broken today | COVERED | PJ-03/96 |
| Previews never email the public | – | – | COVERED | Decision (PJ-94) |

## 11. Admin tools, reports, logs

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Approve pending jobs | AUDIT, QR§8 (5 pending) | ON | COVERED | PJ-32 + 'trusted' |
| User list columns: confirmed, order history, invoice-me, org fields | AUDIT | ON | COVERED | PJ-30 (site-manager admin) |
| CSV: jobs + orders by month (selectable fields); job views | AUDIT | ON | COVERED | Decision: reports (PJ-53) |
| Site log: employer ends/cancels job (wp-site-logs) | AUDIT | ON | COVERED | Decision: credits traceable (org History tab) |
| JobRoller log (`jr_enable_log=1`, `uploads/at-logs`) | QR§6/§33 | ON | DROPPED | Workers Logs (Decision: monitoring) |
| WP Crontrol (cron UI) | active plugins | admin | COVERED | Alert run log + heartbeat (PJ-08/48) |
| Search & Replace plugin | active plugins | admin | DROPPED | n/a |
| UpdraftPlus daily backups | QR§27 | ON | COVERED | Decision: backups |
| Wordfence | active plugins | ON | DROPPED | Decision: security |
| Cloudflare plugin (cache purge) | active plugins | ON | COVERED | PJ-41 |
| User Switching | active plugins | ? | GAP | Gap 8 |
| Export User Data (`q_eud_exports` 2) | QR§12 | rare | DROPPED (proposed) | Not in the active plugin list; site managers export with PJ-46/53 |
| Admin security (`jr_admin_security=edit_others_posts`) | QR§6 | ON | COVERED | Decision 3 (site managers use the Payload admin) |
| Analytics in admin | – (new) | – | COVERED | PJ-110 |

## 12. SEO, feeds, URLs

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| Yoast sitemaps (12 child sitemaps, 28 live jobs missing) | CRAWL§1/§10 | ON | COVERED | PJ-40 (all live jobs) |
| robots.txt | CRAWL | ON | COVERED | PJ-40/104 |
| Yoast titles/descriptions on pages, primary category | QR§13 | ON | COVERED | Decision: GEO (one SEO tab), PJ-104 |
| Feeds: site, jobs, featured `?rss_featured=1`, per-category/type/salary (23), per-org (29), volunteer | CRAWL§6 | ? | COVERED | Decision: RSS on hold (PJ-116) |
| `/resumes/feed/` + 200 CV pages + 176 CV taxonomy URLs (public) | CRAWL§4 | ON | GAP | Gap 4 |
| WP attachment pages (147) | CRAWL§5 | ON | GAP | Gap 10 |
| `?p=` shortlinks (50) | CRAWL§8 | ON | GAP | Gap 10 |
| `/wp/*`, `xmlrpc.php`, `wp-login.php` | CRAWL§3.1 | ON | COVERED | PJ-42 404 (proposed: 410 for /wp/*) |
| Trailing-slash duplicates, `/employer/` → `/employers/` | CRAWL§10 | ON | COVERED | PJ-42 |
| HTTP→HTTPS, apex/www | QR§29 | ON | COVERED | Cloudflare (PJ-74) |
| Organisation URLs `/organisation/{nickname}` | CRAWL§3.4 | ON | COVERED | PJ-38/42 |
| llms.txt, AI crawlers | – (new) | – | COVERED | Decision: GEO (PJ-104) |

## 13. Scheduled tasks

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| WP-cron fired by page loads (no server cron) | QR§27 | – | COVERED | Cron Triggers (PJ-08) |
| Hourly: expire jobs + warning emails | AUDIT | ON | COVERED | PJ-52 |
| Daily: remove expired featured add-ons | AUDIT | ON | COVERED | PJ-87 (expire-job-placements) |
| Daily: job alerts `md_daily_job_alerts` | AUDIT | ON | COVERED | PJ-48 |
| Daily: clear daily view counts | AUDIT | ON | COVERED | PJ-37/110 (daily views in our own counter) |
| `jr_job_alerts` (theme), `app_order_processing`, `jr_check_expired_subscriptions`, `jr_check_packs_expired`, resume reminder | USAGE | dead/dup | DROPPED | USAGE |
| UpdraftPlus daily | QR§27 | ON | COVERED | Decision: backups |
| Wordfence scans | plugin | ON | DROPPED | Decision: security |
| Full hook list | – | [code] | – | Query 39 |
| Retention jobs (applications, forms, email log) | – (new) | – | COVERED | PJ-88, PJ-102, PJ-50 |

## 14. Security and spam

| Item | Evidence | Used? | Status | Decision / ticket or proposed default |
|---|---|---|---|---|
| reCAPTCHA + anti-spam question + honeypot | QR§6 | ON | COVERED | Decision: spam/bots |
| Spam accounts (disposable domains in the top 25) | QR§17 | ON | COVERED | Disposable-email block (Decision: spam/bots) |
| Wordfence firewall / 2FA | plugin, QR§12 | ON | COVERED | Decision: security (2FA post-MVP) |
| Hardcoded secrets (MailChimp key, Xero client ID, Google Maps key in `jr_options`) | AUDIT, USAGE | – | COVERED | PJ-75 (rotate; add the Maps key to the list) |
| `print_r($_POST)` debug leftover | AUDIT | – | DROPPED | Not ported |
| MySQL port 3306 open to the internet | QR§28 | – | COVERED | PJ-73/75 (close at decommission) |
| Public CV pages (personal data) | CRAWL§4 | ON | GAP | Gap 4 |

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
| `jr_ad_stats_all=1` | public view stats | GAP | Gap 6 |
| `jr_show_empty_categories` empty | hide empty | COVERED | Filter URLs decision |
| `jr_allow_job_seekers=1`, `jr_allow_recruiters` empty | roles | COVERED/OFF | Seekers kept; agencies |
| `jr_resume_*` (visibility listers, no subscription, no contact form) | resumes | DROPPED | Decision 1 |
| `jr_captcha_enable=1`, contact/application captcha `no`, antispam Q/A | spam | COVERED | Turnstile |
| `jr_enable_header_banner=1`, `jr_enable_listing_banner=1` | banners | COVERED | Header banner decision |
| `jr_enable_terms_conditions` empty | no T&C box | COVERED | PJ-89 |
| `jr_bcc_apply_emails=1` | admin copy | COVERED | Decision |
| `jr_new_job_email_owner=1`, `jr_expired_job_email_owner=1`, `jr_nu_custom_email=1` | emails | COVERED | Decision: email list |
| `jr_nu_admin_email`, `jr_new_ad_email` empty | admin notices off | GAP / COVERED | Gap 14 |
| `jr_job_alerts=1`, cron daily, limit 5, batch 100, feed off | alerts | COVERED | PJ-48 |
| `jr_gmaps_lang=en`, `jr_gmaps_region=VU`, `jr_distance_unit=km` | geocoder/radius | GAP | Gap 20 |
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
| seeker profile meta, seeker socials | 361 / 541 | DROPPED |
| `THANKSFROMYCV` | 4 | ? (query 46) |
| `wfls-last-login`, Yoast/admin UI meta | – | DROPPED |
| Job: `_Company`, `_CompanyURL`, `_how_to_apply`, recipient, apply-online flag, `_jr_address`, `geo_*`, lat/lng, `_jr_fx_expire_days`, `_displayed_salary`, featured flags, counts | QR§13 | COVERED (PJ-64) |
| Job: `_jr_expired_reason`, `_jr_canceled_job` | 4,317 / 228 | GAP (Gap 7) |
| Job: `_relisting` | 31 | COVERED (import as a History event) |
| Job: `user_IP` | 6,221 | DROPPED (PJ-64) |
| Job: `_jr_days_expire_reminder_email_sent` | 4,184 | DROPPED (expired jobs don't need it; live jobs: PJ-52 sends at most once) |
