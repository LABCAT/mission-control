# vanuatuwok.vu – feature usage (live DB, 22 Oct 2026)

Source: `usage-queries.sql`, run read-only against the production database. The window is the last 24 months unless noted.
Amounts are in Vatu (VT).

## Headline numbers

**Jobs:** about 55–75 per month, steady.

| Year | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 (to Oct) |
|---|---|---|---|---|---|---|---|---|
| Jobs | 658 | 612 | 933 | 873 | 783 | 676 | 709 | 598 |

**Orders:** about 30–75 per month, roughly VT 110k–370k per month.

| Gateway | Orders (24 mo) |
|---|---|
| bank-transfer | 1,315 (VT 5.45M) |
| none / free | 23 |
| PayPal or any other gateway | **0** |

- Orders stay in `tr_pending`. Payment is evidently handled in Xero, not on the site.
- Xero log entries run at roughly the same rate as orders (about 30–76 per month), so the Xero integration is active.

**Jobs by type (24 mo):**

| Full-Time | Contract | Part-Time | Not Stated | Voluntary | Casual | Temporary | Independent |
|---|---|---|---|---|---|---|---|
| 997 | 389 | 13 | 8 | 5 | 3 | 3 | 3 |

## Feature-by-feature

| Feature | Evidence | Verdict |
|---|---|---|
| Job posting and expiry | 55–75 jobs/month; hourly expiry cron scheduled | **Keep** (core) |
| Invoice / bank-transfer checkout | 100% of orders | **Keep** |
| Xero invoices | Log activity matches order volume | **Keep** |
| PayPal, 2Checkout, Authorize.net, Google Wallet | 0 orders | **Drop** |
| Pricing plans | Live plans: Regular job listing, Job pack, 10 Job Pack, Volunteer listing, Enhanced listing (plus one pending "Unlimited 6 month") | **Keep, simplified.** Check with the client which plans sell. |
| Job packs | 22 users hold 62 packs (all time) | **Keep if still sold.** Check recent orders. |
| Featured add-ons (Enhanced/Premium) | Only 4 jobs in 24 months | **Drop** (or a manual "featured" flag) |
| Coupons | 4 codes. `LINKPS` used 493 times in total, last edited 2022. Others barely used. | **Keep if `LINKPS` is still used**; otherwise drop. Could become a per-employer discount. |
| PDF job description upload | 222 jobs in 24 months (about 1 in 5) | **Keep** |
| Job applications (online apply) | About 85–105 per year, steady | **Keep** (simple form + email + stored record) |
| Resumes | About 50–60 new per year; 200 published | **Ask the client.** No resume-access plans or views are recorded, so resume search/paid access looks **unused** → drop it. Keeping plain resumes is optional. |
| Resume-access plans | No user meta for views or trials | **Drop** |
| Job alerts | 246 active subscribers; daily runs logged every day | **Keep** |
| Duplicate theme alerts cron (`jr_job_alerts`) | Also scheduled daily | **Drop.** Check it isn't sending duplicate emails today. |
| Organisation pages | 32 enabled; 27 open listing requests | **Keep** (small) |
| Volunteer flow | Only 5 voluntary jobs in 24 months | **Simplify** to a job type with free posting; no separate flow |
| Blog | 0 published posts | **Drop** |
| Pages | 34 published; last edited 2022 | **Keep** as simple CMS pages |
| `daily_resume_reminder_email`, `jr_check_expired_subscriptions`, `jr_check_packs_expired` | Scheduled, but dead or without a handler | **Drop** |
| Recurring payments (`app_order_processing`) | Scheduled hourly; no gateway uses it | **Drop** |

## Users

| Role | Total | New in 24 mo |
|---|---|---|
| job_lister (employer) | 11,483 | 950 |
| job_seeker | 4,289 | 1,088 |
| admin / editor / contributor | 6 | 0 |

- Registrations by year: 2021: 2,632, 2022: 2,453, **2024: 5,056**, 2025: 1,017.
- With only ~700 jobs a year, most employer accounts are probably **spam or one-off**. Plan to migrate only active users, for example anyone with a job, order, resume, alert or login in the last N years. Everyone else re-registers.

## Other findings

- **Google Maps API key in plain text:** it's stored in `jr_options` (geocoder settings) in the database. Rotate it at cutover and restrict it by referrer in the meantime.
- **Universal Analytics tag:** the site still loads `UA-114140337-1`. Universal Analytics was shut down in 2024, so there's no current analytics. Use Cloudflare Web Analytics or GA4 in the rebuild.
- **Undeclared plugin:** `search-and-replace` is active but not in `composer.json`.

## Effect on scope

**Drop:**
- online payment gateways
- featured add-ons
- resume-access plans and resume search
- blog
- the separate volunteer flow
- dead cron jobs and recurring payments
- the duplicate alerts cron

**Core (keep):**
- jobs, with PDF upload and expiry
- employer accounts with email confirmation
- invoice checkout with plans (and packs, if confirmed)
- Xero invoicing
- online apply and stored applications
- daily job alerts
- organisation pages and directory
- CMS pages
- emails
- CSV reports
- active-user migration

**Confirm with the client:**
- which plans and packs still sell
- the `LINKPS` coupon
- whether plain resumes are worth keeping
