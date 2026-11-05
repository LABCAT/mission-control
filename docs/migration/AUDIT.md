# vanuatuwok.vu – functional audit

Snapshot of what the current WordPress site does, as input for the rebuild on Payload + Cloudflare.
Source: code in this repo (Oct 2026). Paths are relative to `web/app/`.

Every section below is something a spec in the new build has to cover, or a decision to drop it.

## Stack today

- **Core:** Bedrock, WordPress 6.5, PHP 8.3, MySQL over SSL.
- **Theme:** `themes/jobroller` (AppThemes JobRoller 1.9.8, about 82k lines).
  - It is **edited in place**. See `jobroller/changed_files.txt` and the comments marked `//parent theme change`.
- **Child theme:** `themes/efate` (about 12k lines, custom). It overrides most of the templates and forms.
- **Custom plugins (about 9k lines):**
  - `jobroller-extensions`, `appthemes-advanced-emails`, `appthemes-xero-invoices`
  - `wp-job-alerts`, `wp-job-reports`, `wp-organisations`, `wp-site-logs`
- **Third-party plugins:** `fxtender-pro` (JobRoller add-on, about 11.5k lines) and `appthemes-coupons`.
- **Composer plugins:** Yoast, Post SMTP, Wordfence, UpdraftPlus, Smush, Cloudflare, user-switching, wp-crontrol, export-user-data, registration-honeypot, classic-editor, multi-image-metabox.
- **Shared with Do Good Jobs NZ:** the Xero plugin chooses a tenant by site URL, either "Youth Challenge Vanuatu" or "Do Good Jobs Limited". **Do Good Jobs NZ is out of scope**: only the Youth Challenge Vanuatu tenant is rebuilt.

## Users and roles

| Role | Can |
|---|---|
| `job_seeker` | Submit and edit a resume, apply for jobs, set job alerts |
| `job_lister` ("Employer") | Post, edit, relist and end jobs; buy plans and packs; have an organisation page |
| `recruiter` | Same as employer, plus view resumes (only if enabled) |
| `editor` | Manage users, but can't see admins |
| `administrator` | Everything |

**Registration:** role, first name, organisation name (stored in `nickname`), username, email, password, terms, honeypot. Optional MailChimp subscribe. The username is checked against existing Xero contact names.

**Email confirmation:** login is blocked until the user clicks the link at `/confirm/?confirm=KEY`. Users can resend the confirmation, and admins can confirm users by hand.

**Account behaviour:**
- Deleting an employer reassigns their jobs to an `archive` user.
- Users only see their own uploads in the media library.

## Organisations

- An organisation is **not its own entity**. It's a `job_lister` user plus user meta: name, type, size band, the `area-of-focus` user taxonomy, logo/cover image, and social links.
- **Public page:** `/organisation/{nickname}`. It's only live once an admin sets `enable_organisations_page`.
- **Approval flow:** the employer ticks "listing request", the admin gets an email, the admin enables the page, and the employer gets a "now live" email.
- **Directory:** a list of organisations with client-side filters (type, size, area of focus) and a count of current jobs.
- **Link to jobs:** only through the job's author. `_Company` is free text. There's no support for several users in one organisation.

## Jobs

**Fields**
- Title, description and a PDF "job description" upload.
- `job_cat`, `job_type`, `job_tag`, `job_salary`, displayed salary, company and URL, how to apply.
- Location: a Vanuatu island/town picker or a geocoded address (lat/lng), or "Overseas".

**Status and visibility**
- Statuses: pending, publish, expired. Employers can cancel, end early or relist; relisting resets the post date.
- **Volunteer jobs** are the "Voluntary" `job_type` and its child terms. They're kept out of the main archive and have their own listing page and approval email.

**Featured add-ons**
- **Enhanced:** `_jr_featured-listings`.
- **Premium (category featured):** `_jr_featured-cat`. Buying Premium automatically adds 30 days of Enhanced.
- Each add-on has its own duration. A daily cron removes add-ons once they expire.

**Moderation**
- A job publishes straight away if the employer is already approved, the plan is paid, or the employer can pay by invoice.
- Otherwise it waits as pending until an admin accepts it, which also marks the employer as approved.

**Expiry:** an hourly cron sends "expiring soon" and "expired" emails.

**Applications** (fxtender)
- The apply form takes name, email, message, CV and cover letter, with LinkedIn apply as an option.
- It's emailed to the employer, or to a recipient set on the job. The applicant gets a copy.
- Applications are also stored, show on both dashboards, and can be exported as CSV.

**Feeds and SEO**
- RSS feeds for paid and voluntary jobs, with location, salary and company added.
- Yoast SEO plus JobPosting structured data.
- 1200×630 share images are generated when a job is saved.

## Resumes

- Seekers submit and edit a resume with its own set of taxonomies (category, job type, specialities, groups, languages).
- Resume search is limited to people with a resume-access plan, which comes with view limits.
- A "contact the resume author" form emails the seeker.
- **Check whether this is used at all.** The resume reminder email is dead code (it's tied to a 2018 date).

## Commerce

- **Currency:** Vatu (VV / Vt).
- **Job plans** (`pricing-plan`): price, duration and included add-ons. A plan can be restricted to certain categories or job types. New categories are added to every plan automatically.
- **Job packs:** prepaid bundles, stored on the user.
- **Resume-access plans** (`resumes-pricing-plan`).
- **Coupons:** a code with a flat or percentage discount.
- **Gateways:**
  - PayPal.
  - Bank transfer / "Invoice Me", only for users flagged `can_pay_by_bank_transfer`. Their jobs publish straight away.
  - fxtender also registers 2Checkout, Authorize.net and Google Wallet. Check which are actually enabled in the database.
- **Orders:** a `transaction` post type, linked to jobs through P2P. Bank-transfer orders aren't completed automatically, because the constant `ACTIVATE_INVOICES` is never defined.

## Xero (`plugins/appthemes-xero-invoices`)

**Connection**
- OAuth2. An admin connects at `/xero-auth`, and the tokens are stored in WordPress options.
- The client ID is **hardcoded**. The secret comes from `WP_XERO_SECRET`.

**Invoice flow**
1. When an order over 0 is created, the plugin finds or creates the Contact (`AXI-{user_id}`, or an override code) and creates a DRAFT ACCREC invoice. Plan, add-ons and coupon are separate lines, each with its own account code.
2. When a gateway is chosen, the invoice is set to AUTHORISED.
3. When the payment completes, a Payment is recorded against the reconciliation account. This doesn't happen for "Invoice Me" orders.

**Other pieces**
- `/invoice?id=` redirects to the Xero online invoice, or shows a local HTML invoice if that isn't available.
- Every Xero step is logged to the `order-log` post type.
- Settings: account codes, branding theme, due-date days, reconciliation account, tracking category.

## Emails

Most JobRoller emails are replaced by `appthemes-advanced-emails`. Admins can edit the subject, body and from name/address on the "Custom Emails" admin page. Mail goes out through Post SMTP.

- **Account:** register and confirm, resend confirmation, admin copy of new users.
- **Jobs:**
  - "New job" notice to the admin.
  - Submitted/published email to the employer, plus the billing email for invoice users.
  - Approved email, with separate paid and volunteer versions.
  - Pending / order complete.
  - Expiring soon; expired or cancelled.
- **Applications:** the job application with CV and cover-letter attachments (to the employer, a copy to the applicant, and a BCC to the admin if enabled).
- **Organisations:** listing request to the admin; page live to the employer.
- **Other:** resume subscription start and end; contact resume author; contact form.
- **Job alerts:** daily.

## Job alerts (`plugins/wp-job-alerts`)

- **Subscription:** a seeker saves keywords, locations, job types and categories, plus an on/off status, in user meta. They can unsubscribe through a link.
- **Queue:** each new job adds a row to the `jr_alerts` table.
- **Sending:** a daily cron (`md_daily_job_alerts`, midnight GMT) matches subscribers against new jobs in a background process, then sends up to N jobs per email.
- **Log:** each run is logged to the `job-alerts-log` post type.
- **Possible duplicate:** the theme's own `jr_job_alerts` cron may still be running as well. Check before migrating.

## Scheduled tasks

| Task | Frequency | Keep? |
|---|---|---|
| Expire jobs and send the warning emails | hourly | Yes |
| Remove expired featured add-ons | daily | Yes |
| Daily job alerts | daily | Yes |
| Clear the daily view stats | daily | Yes, if view stats are kept |
| Recurring payments (`app_order_processing`) | hourly | Check if used |
| `jr_check_expired_subscriptions`, `jr_check_packs_expired` | daily | No handler is attached; check before rebuilding |
| Resume reminder | daily | Dead code |

## Reports and admin tools

- **CSV exports:** jobs and orders by month, with selectable fields; job view counts.
- **Site log:** records when an employer ends or cancels a job.
- **User admin:** a confirmed/verified column, order history, and "invoice me" and organisation fields.
- **Home page:** hero image and widgets are set in meta boxes on the home page.

## Data to migrate

- **Users:** about 10 roles' worth of user meta. Passwords are WordPress phpass/bcrypt hashes, so plan a reset or a hash-compatible login.
- **Jobs:** posts, meta and the taxonomies above, plus the PDF attachments.
- **Organisation profiles and images.**
- **Commerce:** orders/transactions with their Xero invoice IDs, plans, packs, coupons.
- **Applications** (P2P links) and their uploaded CVs.
- **Resumes**, if they're kept.
- **Alert subscriptions.**
- **View counters**, if they're kept.
- **Media library:** move it to R2.
- **Blog posts and pages.**

## Security and clean-up for the new build

- **Secrets to rotate and move into env:** the MailChimp API key and list IDs (hardcoded in `jobroller-extensions/includes/class-jre-user-registration.php`), the Xero client ID, and the Mailgun/SMTP credentials.
- **Leftover debug code:** `print_r($_POST)` in `jobroller-extensions/includes/class-jre-taxonomies.php:56`.
- **Missing plugin:** the JavaScript references a "Delete Me" account-deletion form, but that plugin isn't in the repo.

## Questions for the client

1. Which payment gateways are actually used? (Most likely PayPal and Invoice Me.)
2. Are resumes and resume-access plans still used?
3. Are job packs and coupons still used?
4. Who in the client's team uses the admin day to day, and what do they do there most?
