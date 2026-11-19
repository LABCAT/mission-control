# Mission Control – tasks

Small tasks for the Daruma board, project **Payload Jobs** (prefix `PJ-`).

- **Agent** tasks: one coding-agent session, one PR.
- **LABCAT** tasks: founder only (spend, secrets, DNS, applying migrations to prod, cutover).
- **Repo for all Agent tasks:** `LABCAT/mission-control`, downstream of `LABCAT/orbit` (see `docs/UPSTREAM.md`).
- **Dispatch:** OpenHands isn't set up yet. Tasks can be run by hand in OpenCode/OpenChamber with the prompt from the board.
- **New rows:** `status=backlog`, `dispatch_status=none`. `blocked_by_task_id` = the latest task listed in **After**. The full dependency list is in each prompt.

---

## Shared brief (prepend to every Agent prompt)

```
Repo: LABCAT/mission-control — multi-tenant job board platform, fork of LABCAT/orbit (upstream).
First tenants: "hub" (LABCAT aggregate site) and "vwok" (vanuatuwok.vu, migrating off WordPress/JobRoller).
Layout: apps/cms (multi-tenant Payload 4 beta + TanStack Start on Cloudflare Workers, Neon via Hyperdrive, R2),
apps/hub + apps/vwok (Astro on Workers), packages/payload-jobs, packages/payload-xero, packages/payload-wp-import,
packages/launchpad (Astro theme on @labcat2020/rocketship + typed CMS client).
Docs: docs/UPSTREAM.md, docs/migration/PLAN.md, AUDIT.md (what the old site does), USAGE.md (what is used — build only that).
Legacy reference (read-only): LABCAT/vanuatuwok.vu @ migration-plan (web/app/themes/efate, web/app/plugins/*).
FIRST read AGENTS.md (setup, checks, migrations, Payload 4 gotchas).
Rules:
- One PR, based on main (never stack on another branch), small diff, this task only. PR body: "Fixes #<issue>", what changed, how verified.
- Keep orbit's files untouched where possible; put job-board code in packages/ or new apps/ so upstream merges stay clean.
- Pin exact versions (match orbit's Payload beta). No "latest"/"*".
- Never hardcode tenant values: currency, timezone, locale, locations, email sender, domain come from the tenant.
  Money = integer minor units + currency code.
- Schema changes: generate the migration with `pnpm payload migrate:create` in a SEPARATE commit and add the
  `migration` label to the PR. Never edit existing migrations. Never run migrations against Neon main.
- Every collection that is imported from WordPress gets an indexed optional `legacyId` (number).
- Astro sites: zero client JS by default; islands only for forms. Do not add UI frameworks.
- Rocketship first: use @labcat2020/rocketship components (forms, Card, Stack, Grid, Table, Dialog...) and --rs-* tokens.
  Never restyle or copy them. If a GENERIC component is missing, stop and note it in the PR — it belongs in LABCAT/rocketship.
- No secrets in code; document new env vars/bindings in the app's .env.example / .dev.vars.example.
- Do not edit CI workflows unless the task says so.
- Tests: meaningful tests for logic (access, pricing, matching, mapping, tenant isolation). No trivial happy-path tests.
- Done = typecheck, lint, test, build all pass for affected packages.
```

---

## Wave 0 – Setup (LABCAT)

| Slug | Title | After |
|---|---|---|
| PJ-01 | Create mission-control from orbit (done) | – |
| PJ-02 | Neon, Hyperdrive, R2 and Worker names | PJ-01 |
| PJ-03 | Email sending domain + Turnstile for vanuatuwok.vu | – |

**PJ-01** – done 2026-10-22
- Created `LABCAT/mission-control` (private) with orbit's full history. `upstream` = orbit, and push to it is disabled locally. GitHub can't fork within the same account.
- Copied the docs in, and added `docs/UPSTREAM.md`.
- **Later:** connect the repo to the Payload Jobs project on the Daruma board, and install OpenHands once agent dispatch is wanted.

**PJ-02**
- Neon project `mission-control` with branches `main` and `dev`, plus a Hyperdrive config.
- R2 bucket `mission-control-media`.
- Worker names: `mc-cms`, `mc-hub`, `mc-vwok`.
- Set the secrets (`PAYLOAD_SECRET` etc.) and put the resource IDs in `docs/INFRA.md`.

**PJ-03**
- Confirm who controls DNS for vanuatuwok.vu.
- Set up Cloudflare Email Sending for the domain (SPF, DKIM, DMARC).
- Create a Turnstile widget covering the hub and vwok hostnames.

---

## Wave 1 – Monorepo foundation

| Slug | Title | Who | After |
|---|---|---|---|
| PJ-04 | Add `packages/*` workspace, shared tsconfig, lint and vitest; CI runs packages | Agent | PJ-01 |
| PJ-05 | Weekly "sync from orbit" PR workflow | Agent | PJ-01 |
| PJ-06 | Multi-tenancy: tenants collection + multi-tenant plugin + roles | Agent | PJ-04 |
| PJ-07 | Site read API: tenant resolution + per-site API keys | Agent | PJ-06 |
| PJ-08 | Cron Triggers → Payload jobs runner + heartbeat | Agent | PJ-04 |
| PJ-09 | Email adapter: Cloudflare Email Sending, sender per tenant | Agent | PJ-06 |
| PJ-10 | R2 storage for media + documents collections | Agent | PJ-06 |
| PJ-11 | `packages/launchpad`: Astro theme on Rocketship + tenant tokens | Agent | PJ-04 |
| PJ-12 | `apps/hub` Astro on Workers + Lighthouse CI budget | Agent | PJ-11 |
| PJ-13 | `apps/vwok` Astro on Workers | Agent | PJ-12 |
| PJ-14 | Deploy cms/hub/vwok to workers.dev + create the hub and vwok tenants | LABCAT | PJ-07–PJ-13 |

**PJ-04**
- Add `packages/*` to `pnpm-workspace.yaml`.
- Add `tsconfig.base.json`, ESLint config and vitest at the root.
- Add root scripts `typecheck`, `lint`, `test` and `build`, run with `pnpm -r`.
- Add `.github/workflows/mc-checks.yml` that runs the root scripts on PRs. Don't edit orbit's `ci.yml`, so upstream merges stay clean.
- Create an empty `packages/payload-jobs` package exporting `payloadJobs(options): Plugin` (a no-op for now), registered in `apps/cms` `payload.config.ts`, with one test.

**PJ-05**
- `.github/workflows/upstream-sync.yml` (allowed): runs weekly and on manual trigger. It fetches `LABCAT/orbit` `main`, merges it into a branch `upstream-sync/<date>`, and opens a PR (or comments on conflicts).
- `docs/UPSTREAM.md` already exists. Link the workflow from it.

**PJ-06**
- Add `@payloadcms/plugin-multi-tenant`, pinned to orbit's beta.
- A `tenants` collection with:
  - `name`, `slug`, `domains[]`, `isAggregate` (bool)
  - `currency` (ISO 4217), `currencyMinorUnits` (int; 0 for VUV), `timezone` (IANA), `locales[]`, `defaultLocale`, `taxLabel`
  - `emailFromName`, `emailFromAddress`, `adminEmail`
  - `branding` group: logo, `colorPrimary`, `colorAccent`, `colorHover`
- Roles on users: `super-admin` (global), plus per tenant `tenant-admin`, `editor` and `employer`.
- Tests: a tenant-admin of A can't read or write tenant B's documents.

**PJ-07**
- A `site-keys` collection (super-admin only): `tenant`, hashed key, label.
- Middleware for read requests from site apps (header `x-site-key`) that scopes the request to that tenant.
- A key on the aggregate tenant can read published content from **all** tenants.
- Tests for tenant isolation and aggregate reads.

**PJ-08**
- A `scheduled()` handler on the cms Worker that runs Payload jobs queues `hourly` and `daily`. One hourly cron (`0 * * * *`) runs the `hourly` queue every time, and the `daily` queue for each tenant whose local time is 00:00.
- A `heartbeat` task that writes the time to a `system-status` global.
- **Done when:** `wrangler dev --test-scheduled` updates the global.

**PJ-09**
- A Payload email adapter that uses the Cloudflare Email Sending binding in Workers and logs to the console in dev.
- Helper `sendTenantEmail({ tenant, to, subject, html })`, which takes the from name and address from the tenant.
- Unit test for the message mapping.

**PJ-10**
- Use orbit's `Media` collection with R2 storage (binding `MEDIA`), tenant-scoped, with resized variants (sizes picked for a PageSpeed score of 100: 320/640/960/1280, webp/avif if supported).
- A new tenant-scoped `documents` collection: PDF, DOC and DOCX, max 10 MB.
- Access tests.

**PJ-11**
- `packages/launchpad` (Astro), depending on `@labcat2020/rocketship` **0.3.0+**, pinned.
- `BaseLayout`: head, SEO meta and canonical slot, header and footer slots. It loads the Rocketship styles and maps the tenant's branding onto `--rs-color-*` tokens (CSS custom properties only).
- **Job-board compositions only**, built from Rocketship components:
  - `JobCard` and `OrgCard`, built on `Card`
  - `FilterBar`, built on `Field`, `Input` and `Select` in a GET form that works without JavaScript
  - `Turnstile`, a small island using `Field`
- **Pagination:** if Rocketship doesn't have it, add it to Rocketship first (an RCL task) and use it here once it's released. A temporary local version is fine, as long as it's marked for removal.
- No data fetching yet. A demo page in `packages/launchpad/demo` that builds in CI.

**PJ-12**
- `apps/hub`: Astro with `@astrojs/cloudflare`, its own `wrangler.jsonc` (`mc-hub`), and launchpad.
- A placeholder home page.
- Lighthouse CI (`@lhci/cli`) in CI (allowed) with performance, accessibility, best practices and SEO each at ≥ 0.98, plus a budget of under 50 KB total JavaScript.

**PJ-13**
- `apps/vwok`: same setup as the hub, Worker `mc-vwok`, Vanuatu Wok branding (green `#06914b`, red `#dd3333`, blue `#0066bf`, logo from the legacy uploads), and covered by Lighthouse CI.

**PJ-14**
- Deploy all three Workers.
- In the admin, create the `hub` tenant (aggregate) and the `vwok` tenant (VUV, 0 minor units, `Pacific/Efate`, `en`), and a site key for each app.
- Check that each app can read from the cms.

---

## Wave 2 – `payload-jobs` data model

All Agent tasks except PJ-28. Each one is collection config, access control and tests only, inside `packages/payload-jobs`. Collections are tenant-scoped unless noted. Legacy fields are in AUDIT.md.

| Slug | Title | After |
|---|---|---|
| PJ-15 | Plugin options + test harness (Postgres in CI) | PJ-06 |
| PJ-16 | Taxonomies: categories, types (isVolunteer), tags, salary bands, areas of focus | PJ-15 |
| PJ-17 | Locations (tree) + Vanuatu seed | PJ-15 |
| PJ-18 | Organisations collection + employer membership | PJ-16 |
| PJ-19 | Jobs collection + access | PJ-17, PJ-18, PJ-10 |
| PJ-20 | Pages collection + per-tenant Home global | PJ-15, PJ-10 |
| PJ-21 | Plans collection + pricing function | PJ-16 |
| PJ-22 | Coupons + `applyCoupon` | PJ-15 |
| PJ-23 | Orders collection | PJ-19, PJ-21, PJ-22 |
| PJ-24 | Organisation job credits (packs) + ledger | PJ-23 |
| PJ-25 | Applications collection | PJ-19 |
| PJ-26 | Alert subscriptions (email-only, double opt-in) | PJ-16, PJ-17 |
| PJ-27 | Email templates per tenant + seed | PJ-09 |
| PJ-28 | Review and apply migrations to Neon main | LABCAT, after PJ-27 |

**PJ-15**
- Plugin options: `{ features: { applications, alerts, credits, coupons } }`.
- A test helper that boots Payload against the CI Postgres, with seeded tenants A and B.
- A shared `tenantIsolation(collection)` test helper that the later tasks use.

**PJ-16**
- `job-categories`, `job-types` (`isVolunteer`), `job-tags`, `salary-bands`, `areas-of-focus`.
- Each has `name` (localized), a unique `slug` per tenant, and `legacyId`.
- Public read; tenant-admin/editor write.

**PJ-17** – done 2026-11-14
- `locations`: `name`, `slug`, `kind` (region, island or town), `parent`, `legacyId`.
- Public read; tenant-admin/editor write. Slug is unique per tenant (`validateSlug` plus a
  `(tenant, slug)` unique index added in multi-tenant mode).
- A parent must be broader than its child (region ← island ← town), which keeps the tree
  acyclic; a parent in another tenant is rejected.
- The seed mirrors the legacy picker (`island → town`, no province level) and adds the
  `Overseas` and `Other` catch-alls. Run it with `SEED_LOCATIONS_CONFIRM=1 pnpm seed:locations <tenant-slug>`
  in `apps/cms`; it names one tenant on purpose (the tree is Vanuatu data, not tenant
  configuration), refuses an aggregate tenant, and is idempotent.

**PJ-18** – done 2026-11-18
- `organisations`:
  - `name`, `slug`, `type` (business, government, NFP, consultant, recruiter, social enterprise), `size`, `areasOfFocus`
  - `logo` and `cover`, `website`, socials, `phone`, `location`, `about`
  - `pageEnabled` (tenant-admin only), `listingRequested`
  - billing (tenant-admin only): `canPayByInvoice`, `billingEmail`, `xeroContactCode`
  - `approved` (bool), `legacyId`
- Users get `organisation` (relation).
- Employers can edit their own organisation, but not the admin-only fields.
- The employer profile is a document, not user meta: `users.organisation` replaces the WordPress
  `job_lister` meta. A later task can let several accounts share one organisation.
- Access: super admin all; tenant-admin/editor read and write in their tenants; an employer reads
  and updates only their own organisation (`create`/`delete` are staff-only, so PJ-29 creates the
  pair with `overrideAccess`); seekers nothing; an anonymous site key reads only `approved`
  organisations whose page is enabled — its tenant's, or every tenant for an aggregate key.
  `approved`, `pageEnabled` and the billing fields use field-level access, so an employer's write
  to them is dropped rather than honoured. This is why `organisations` is deliberately absent
  from `site-keys.ts`'s allowlist: its own filter is narrower.
- Slug is unique per tenant (`validateTaxonomySlug` plus a `(tenant, slug)` unique index); `website`
  and the socials must be full `http(s)` URLs.
- Tenant is sticky: only a tenant admin of both the tenant an organisation leaves and the one it
  joins may move it. Relations to media, locations and areas of focus must belong to the same
  tenant.
- Deviation from WordPress: `size` and `type` are URL-safe enum values rather than display
  strings, and the legacy `enable_organisations_page` flag becomes two fields — an employer asks
  (`listingRequested`), a tenant admin approves (`approved`) and turns the page on (`pageEnabled`).
  The legacy `nickname` is `slug`.

**PJ-19**
- `jobs`:
  - `title`, `slug` (unique per tenant), `description` (rich text), `jobDescriptionPdf`
  - taxonomies, `displayedSalary`, `companyName` (defaults to the organisation's name), `companyUrl`, `howToApply`, `location`, `address`
  - `applyOnline`, `applicationsRecipient`
  - `organisation`, `createdBy`
  - `status` (`draft` | `pending` | `published` | `expired` | `cancelled`), `publishedAt`, `expiresAt`, `plan`, `order`
  - `views`, `legacyId`
- Access:
  - the public can read jobs that are `published` or `expired`
  - employers can create jobs and update their own organisation's `draft`/`pending` jobs
  - tenant-admin/editor can do everything
- Tests, including tenant isolation.
- Deferred from PJ-19 (#62): `order` waits for the orders collection and is added in PJ-23. `createdBy` is not in #62 either; it follows with the order relationship.

**PJ-20**
- `pages`: `title`, `slug`, `content`, SEO group, `legacyId`.
- A per-tenant `site-settings`, made a tenant-scoped collection or global per the plugin's pattern, with: hero image and text, promo blocks, nav links, footer text, analytics ID.

**PJ-21**
- `plans`: `name`, `price` (minor units), `durationDays`, `jobCredits`, `allowedCategories`/`allowedTypes`, `isVolunteer`, `active`, `sortOrder`, `legacyId`.
- Pure function `priceFor(plan, coupon?, tenant)`, with tests (VUV has 0 decimals, NZD has 2).

**PJ-22**
- `coupons`: `code` (unique per tenant, uppercase), `discountType`, `amount`, `active`, `useCount`, `maxUses`, `legacyId`.
- `applyCoupon` with tests: flat, percent, floor at 0, `maxUses`.

**PJ-23**
- `orders`: `organisation`, `plan`, `coupon`, `subtotal`, `discount`, `total`, `currency`, `status` (`pending` | `paid` | `cancelled` | `failed`), `paymentMethod` (`invoice` | `free` | `credit`), `jobs`, `xeroInvoiceId`, `xeroInvoiceUrl`, `log[]`, `legacyId`.
- An employer can read their own organisation's orders.
- Also adds `jobs.order` (and `jobs.createdBy`), deferred from PJ-19, with their migration. Like the other private job fields, they're readable only by staff and the owning organisation (`jobPrivateFieldRead`).
- Access tests.

**PJ-24**
- On `organisations`: `jobCredits` (int) and a `creditLedger[]` of `{at, delta, reason, order}`.
- Transactional `grantCredits` and `consumeCredit`.
- Tests: credits never go below 0, and the ledger stays consistent.

**PJ-25**
- `applications`: `job`, `name`, `email`, `message`, `cv`, `coverLetter`, `legacyId`.
- Readable by the job's organisation and the tenant-admin.
- No public REST create; the form endpoint comes in PJ-45.

**PJ-26**
- `alert-subscriptions`: `email`, `confirmed`, `confirmToken`, `manageToken`, `keywords`, `categories`, `types`, `locations`, `lastSentAt`, `legacyId`.
- Admin read only; all public changes go through the token endpoints in PJ-47.

**PJ-27**
- A tenant-scoped `email-templates` collection: `key`, `subject`, `body` (with `{{placeholders}}`), `enabled`.
- A seed with the keys and default text from the legacy `appthemes-advanced-emails`, but only for emails kept in USAGE.md.

**PJ-28 (LABCAT)**
- Review all the migration PRs.
- Merge them, then tag a release (orbit's release workflow migrates and deploys).

---

## Wave 3 – Employer experience (Payload admin)

All Agent tasks.

| Slug | Title | After |
|---|---|---|
| PJ-29 | Employer sign-up endpoint + email verification | PJ-18, PJ-27, PJ-09 |
| PJ-30 | Admin UX for employers: trimmed nav, job form layout, dashboard widget | PJ-19 |
| PJ-31 | Checkout admin view: plan → coupon/credit → order (invoice) | PJ-23, PJ-24, PJ-30 |
| PJ-32 | Publish and moderation rules + approve action | PJ-31 |
| PJ-33 | Job actions: end early, relist | PJ-32 |
| PJ-34 | WordPress password hash compatibility | PJ-29 |

**PJ-29**
- `POST /api/tenants/:slug/employer-signup`: name, email, password, organisation name, Turnstile and a honeypot field.
- Creates an unverified employer user and a new organisation (`approved: false`).
- Sends the verification email (Payload `verify`) using the tenant template.
- Tests: an unverified user can't log in; the endpoint is rate limited.

**PJ-30**
- For the employer role, the admin nav shows only Jobs, Organisation, Orders and Applications.
- The job edit view is grouped into tabs: details, location, apply, files.
- A dashboard widget showing live, pending and ended counts, plus credits.
- Super-admin and tenant-admin views stay as they are.

**PJ-31**
- A custom admin view `/admin/checkout/:jobId`:
  - choose an allowed plan
  - optionally apply a coupon
  - use a credit if the organisation has one; otherwise create an order (`invoice`, or `free` when the total is 0)
- Pack plans grant credits.
- Uses `priceFor`. Tests for the server action.

**PJ-32**
- After checkout the job goes to `published` if the organisation is `approved`, or the total is above 0, or the organisation has `canPayByInvoice`. Otherwise it goes to `pending`.
- `expiresAt` = publish date + duration, calculated in the tenant's timezone.
- A tenant-admin "Approve" action publishes the job and approves the organisation.
- Tests for the rule.

**PJ-33**
- **End early:** sets the job to `expired` and logs it.
- **Relist:** duplicates the job as a draft and goes to checkout.
- Available to the job's organisation and to tenant-admins. Tests.

**PJ-34**
- A `beforeLogin` hook or custom strategy. If the user has a `legacyPasswordHash` (WordPress phpass `$P$`, or bcrypt `$wp$2y$`), verify against it. On success, set the Payload password and clear the legacy hash.
- Use pure-JS hashing that runs on Workers.
- Fixture tests with known WordPress hashes.

---

## Wave 4 – Astro sites

All Agent tasks. Shared pages and components live in `launchpad`. The apps compose them.

| Slug | Title | After |
|---|---|---|
| PJ-35 | Typed CMS client in launchpad + edge cache helper | PJ-07, PJ-11 |
| PJ-36 | Job listing page + filters (SSR + edge cache) | PJ-35, PJ-19 |
| PJ-37 | Job detail page + JobPosting JSON-LD + OG | PJ-35, PJ-19 |
| PJ-38 | Organisation directory + organisation page | PJ-35, PJ-18 |
| PJ-39 | Home + CMS pages | PJ-35, PJ-20 |
| PJ-40 | RSS, sitemap.xml, robots.txt | PJ-36, PJ-37, PJ-38, PJ-39 |
| PJ-41 | Cache invalidation: CMS hooks purge site caches | PJ-36–PJ-39 |
| PJ-42 | vwok: legacy URL 301 map + 404 | PJ-40 |
| PJ-43 | hub: cross-tenant listing with a site/country filter, canonical links to the tenant site | PJ-36 |
| PJ-44 | Performance pass to 100 | PJ-42, PJ-43 |

**PJ-35**
- A typed fetch client for the cms REST API (`x-site-key`), using the generated `payload-types`.
- A `cached(key, ttl, fn)` helper using the Workers Cache API, with tag-based keys for purging.
- Tests using mocked fetch.

**PJ-36**
- `/jobs`:
  - Filters (keyword, category, type, location, voluntary off by default) are kept in the query string and work without JavaScript.
  - 20 per page.
- `/jobs/category/:slug` and `/jobs/type/:slug`.
- HTML cached at the edge for 5 minutes, with a purge tag.

**PJ-37**
- `/jobs/:slug`:
  - All the fields, the PDF link, the organisation card, and an apply section (placeholder until PJ-45).
  - Expired jobs show a banner.
  - JobPosting JSON-LD, OG and Twitter meta.
- Views are counted with a `navigator.sendBeacon` to a cms endpoint that ignores bots.

**PJ-38**
- `/organisations`, with type/size/area filters and current job counts.
- `/organisation/:slug`: the profile plus that organisation's current jobs.

**PJ-39**
- `/` built from site-settings: hero, latest 10 jobs, search, promo blocks.
- `/:slug` renders CMS pages.

**PJ-40**
- `/feed/jobs.xml` and `/feed/voluntary-jobs.xml`, as RSS 2.0 including location, salary and company.
- `sitemap.xml` and `robots.txt`.

**PJ-41**
- `afterChange`/`afterDelete` hooks on jobs, organisations, pages and site-settings call each affected site's purge endpoint (signed). The tenant's own site and the hub are both purged.
- Tests.

**PJ-42**
- Map the legacy URLs from the old theme's permalinks plus a crawl of the live sitemap to the new routes:
  - `/jobs/:slug/`
  - `/job-category/:slug/`, `/job-type/:slug/`
  - `/author/:nick/`, `/organisation/:nick/`
  - `/feed/`
  - `/wp-*` → home
- Return 301s. A table-driven test.

**PJ-43**
- The hub's `/jobs` aggregates every tenant, with a filter by site/country.
- Job detail links and the canonical URL point to the tenant's own site. The hub doesn't duplicate job pages, to avoid duplicate content for SEO.

**PJ-44**
- Run Lighthouse on home, `/jobs` and job detail, for both apps, on mobile.
- Fix anything below 100: fonts (self-hosted, preloaded, subset), image sizes and `srcset`, critical CSS, no layout shift.
- Tighten the Lighthouse CI thresholds to 1.0.

---

## Wave 5 – Applications, alerts, emails, scheduled jobs

All Agent tasks.

| Slug | Title | After |
|---|---|---|
| PJ-45 | Apply form island → cms endpoint (Turnstile, files to R2, emails) | PJ-25, PJ-37, PJ-50 |
| PJ-46 | Applications list for employers in the admin + CSV export | PJ-45, PJ-30 |
| PJ-47 | Alerts: subscribe form, confirm, manage and unsubscribe pages | PJ-26, PJ-50 |
| PJ-48 | Daily alerts digest per tenant (local time) | PJ-08, PJ-47 |
| PJ-49 | Contact form | PJ-50, PJ-39 |
| PJ-50 | Template renderer + `sendTemplate` + email log | PJ-27 |
| PJ-51 | Wire up the job, order, account and organisation emails | PJ-50, PJ-32 |
| PJ-52 | Hourly: expire jobs + expiring-soon email | PJ-08, PJ-51 |
| PJ-53 | Admin CSV report: jobs + orders by month | PJ-23 |

**PJ-45**
- A form (name, email, message, CV required, cover letter, Turnstile) that works without JavaScript, with an island only for upload progress.
- The endpoint stores the application.
- Emails the organisation (or `applicationsRecipient`) with signed, expiring file links, plus a copy to the applicant.

**PJ-46**
- An admin list filtered to the employer's organisation's jobs.
- Tenant-admin CSV export with a date range.

**PJ-47**
- A subscribe form (email plus filters) that sends a confirmation email.
- `/alerts/confirm/:token` and `/alerts/manage/:token` (edit or unsubscribe).
- Rate limited, with Turnstile.

**PJ-48**
- For each tenant, at its local run hour, match confirmed subscriptions against jobs published since `lastSentAt`, and send up to 20 jobs per digest.
- Batched through the jobs queue. Tests for the matching.

**PJ-49**
- `/contact`: name, email, message, Turnstile. Sends to the tenant's `adminEmail`.

**PJ-50**
- Renders `{{placeholders}}` with escaping, inside a shared HTML layout using the tenant's branding.
- Skips disabled templates.
- Logs to an `email-log` collection.
- Tests.

**PJ-51**
- New job → tenant admin.
- Submitted/published → employer (plus the billing email for invoice organisations).
- Approved → employer.
- Order created → employer.
- Expired/ended → employer.
- Organisation listing requested → admin.
- Organisation page live → employer.

**PJ-52**
- Expire published jobs past `expiresAt`.
- "Expiring soon" email 3 days before, idempotent.
- Fake-clock tests.

**PJ-53**
- Tenant-admin view: choose a range, download CSV.

---

## Wave 6 – `packages/payload-xero` (much later)

Xero is deferred until after the sites are live. Until then, orders are created as `invoice` and invoiced by hand in Xero, as they are today. Priority: low.

All Agent tasks except PJ-59. Legacy reference: `web/app/plugins/appthemes-xero-invoices`.

| Slug | Title | After |
|---|---|---|
| PJ-54 | Plugin skeleton + per-tenant Xero settings + encrypted tokens | PJ-23 |
| PJ-55 | OAuth2 connect and refresh, per tenant | PJ-54 |
| PJ-56 | Find or create a contact | PJ-55 |
| PJ-57 | Order → invoice (draft → authorised), with retry job | PJ-56, PJ-31 |
| PJ-58 | Invoice link for employers (Xero online URL or HTML fallback) | PJ-57 |
| PJ-59 | Xero app + connect the YCV tenant (demo company first) | LABCAT, after PJ-55 |

**PJ-54**
- A tenant-scoped `xero-settings` collection: tenant ID, account codes (plan, discount), branding theme, due days, reconciliation account, tracking category.
- AES-GCM-encrypted tokens, with the key from env.

**PJ-55**
- `/api/xero/connect` and `/api/xero/callback` for a tenant-admin.
- Scopes: `offline_access accounting.transactions accounting.settings accounting.contacts`.
- `fetch` only, no Node-only SDK.

**PJ-56**
- Look up the contact by `xeroContactCode`, then `AXI-{legacyUserId}`, then email. Create one if none is found.
- Tests using mocked fetch.

**PJ-57**
- When an order is created with a total above 0, create an ACCREC DRAFT invoice. Authorise it when checkout completes.
- Store the ID and the online URL, and append to the order log.
- A failure queues a retry job.
- Tests using mocked fetch.

**PJ-58**
- An admin field or action on orders that opens the invoice.

---

## Wave 7 – `packages/payload-wp-import`

All Agent tasks except PJ-69. Runs locally with Node against a MySQL copy, writing to Neon `dev` through the Payload local API.

| Slug | Title | After |
|---|---|---|
| PJ-60 | Import framework: MySQL reader, idempotent upsert by `legacyId`, dry run | PJ-28 |
| PJ-61 | Taxonomies + locations mapping | PJ-60 |
| PJ-62 | Active users + organisations + legacy hashes | PJ-60, PJ-34 |
| PJ-63 | Media, logos and PDFs to R2 | PJ-60 |
| PJ-64 | Jobs (published + expired) | PJ-61, PJ-62, PJ-63 |
| PJ-65 | Plans, coupons, orders (24 months) and credits | PJ-64 |
| PJ-66 | Applications + alert subscribers (as confirmed) | PJ-64 |
| PJ-67 | Pages + site settings | PJ-63 |
| PJ-68 | Verification report (legacy vs new counts) | PJ-61–PJ-67 |
| PJ-69 | Full import into Neon dev + review | LABCAT, after PJ-68 |

**PJ-60**
- A CLI `pnpm wp-import <entity> --tenant vwok [--dry-run] [--limit]`, using `mysql2` with a read-only DSN from env.
- Fixture-based tests. The WordPress meta keys are in AUDIT.md.

**PJ-62**
- "Active" means any of:
  - registered in the last 3 years
  - has a job or order since 2022
  - is an admin or editor
- Each `job_lister` user's meta becomes an organisation, with that user as its first employer. Duplicate organisations are merged by name.
- `user_pass` goes to `legacyPasswordHash`.

**PJ-63**
- Stream files from the live uploads URL into R2, keeping the paths. Resumable.

**PJ-64**
- Imports all published and expired `job_listing` posts with their meta, taxonomies, PDF and organisation.

**PJ-65**
- `transaction` posts from the last 24 months, linked to jobs through P2P `order-connection`.
- `_xero_invoice_id` is kept.
- `_jr_user_pack-*` becomes credits.

**PJ-66**
- Applications from P2P `jr_job_application`.
- Alert subscriptions from the `jr_alert_*` user meta where status is active.

**PJ-68**
- A markdown report per entity. Exits non-zero if the counts differ by more than the skipped totals.

---

## Wave 8 – Verify and cut over

| Slug | Title | Who | After |
|---|---|---|---|
| PJ-70 | URL parity crawler (live sitemap vs the new vwok) | Agent | PJ-42, PJ-69 |
| PJ-71 | Playwright e2e: signup → verify → post → checkout → apply → alert | Agent | PJ-53 |
| PJ-72 | Staging run with the Xero demo company and real email | LABCAT | PJ-70, PJ-71, PJ-59 |
| PJ-73 | Cutover runbook (`docs/CUTOVER.md`) | Agent | PJ-72 |
| PJ-74 | Cutover: freeze, final import, DNS to `mc-vwok`, monitor 48h | LABCAT | PJ-73 |
| PJ-75 | Decommission: rotate secrets, snapshot and power off the droplets | LABCAT | PJ-74 + 30 days |

**PJ-70**
- Every `<loc>` from `https://vanuatuwok.vu/sitemap_index.xml` must give a 200 with a matching title, or a 301 to a URL that returns 200, on the new site.
- Write a CSV report and exit non-zero on failures.

**PJ-71**
- Playwright against a local stack with a seeded database and email captured to a dev inbox.
- Add it as a CI job (allowed).

**PJ-73**
- Step-by-step runbook with a rollback: point DNS back at the droplet, which stays powered on until PJ-75.
