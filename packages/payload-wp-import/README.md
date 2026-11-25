# @mission-control/payload-wp-import

Framework for importing the legacy WordPress/JobRoller database into Payload. Entity importers
(taxonomies, users, media, jobs, orders, applications, pages) plug into it.

## Environment

| Variable | Purpose |
|---|---|
| `WP_IMPORT_MYSQL_URL` | MySQL DSN of the legacy WordPress database, `mysql://USER:PASSWORD@HOST:PORT/DB`. Use a read-only user. |

See `.env.example`. Never commit values.

## Usage

```ts
import { runImport, type Importer } from '@mission-control/payload-wp-import'

const terms: Importer<{ term_id: number; name: string }> = {
  name: 'terms',
  collection: 'job-types',
  dependsOn: [],
  read: (reader) => reader.rows('terms', { key: 'term_id' }),
  map: (row) => ({ legacyId: row.term_id, data: { name: row.name } }),
}

const summary = await runImport({ payload, tenant: tenantId, importers: [terms], dryRun: true })
```

- **`MysqlReader`**: SELECT-only, session set to `READ ONLY`. Table prefix defaults to `wp_`
  (`new MysqlReader({ prefix })`). `rows(table, { key, where, params })` pages by keyset on `key`
  (default `ID`; use `meta_id`, `term_id`, … for other tables).
- **`runImport`**: runs importers in `dependsOn` order (unknown dependency or cycle throws),
  upserts by `legacyId` + tenant, so re-runs update instead of duplicating. `dryRun` does the
  lookups but no writes, and the counts show what a real run would do.
- **Results**: per-importer `created / updated / skipped / failed`, plus `errors[]` with the
  importer and `legacyId`. Row errors never stop the run. If an importer cannot read, it is
  marked `aborted` and its dependents are not run.

## Importers

Registered in `src/registry.ts`, so `pnpm wp-import <entity> --tenant <slug>` works for each.

| Entity | Target collection | Source |
|---|---|---|
| `locations` | `locations` (audit only) | `_jr_geo_*` job post meta |
| `job-categories` | `job-categories` | `wp_term_taxonomy.taxonomy = 'job_cat'` |
| `job-types` | `job-types` | `job_type` |
| `salary-bands` | `salary-bands` | `job_salary` |

`job_tag` and the `area-of-focus` user taxonomy are not imported: their Payload collections were
removed in PJ-80 because the legacy database has no terms for them.

The three taxonomy importers write `name` (entities decoded, so `&amp;` becomes `&`), `slug` and
`legacyId`. Slugs keep the legacy value when it is valid, otherwise one is derived from the name.
Two legacy slugs that sanitise to the same value are told apart by appending the `term_id`
(`trades-services-33`), which stays stable across runs. A damaged term (no usable name or slug)
is counted as skipped.

`job-types` also sets `isVolunteer`: true for the "Voluntary" term and every term below it in the
legacy tree (AUDIT.md), false for the rest. The other collections keep no parent relation, so the
hierarchy is only used here.

### Locations

The legacy site has no location taxonomy. The job form saves the picker (`Town, Island`) or a
free-text geocoded address in post meta, and the theme parses the string back into the picker
(`regions-and-towns.js`, `displaySavedAddress`). So the tree is the tenant's own (seeded by PJ-17),
and the `locations` importer is an **audit**:

- It reads the distinct location labels of the legacy jobs (`_jr_geo_short_address`,
  `_jr_geo_address`, `_jr_geo_town`, `_jr_geo_region`) and resolves each against the tenant's
  locations: parent-and-name first (`Luganville, Espiritu Santo`), then name, then slug, ignoring
  case, punctuation and spacing (`White Sands` = `Whitesands`). `Santo` resolves to Espiritu Santo
  when the tenant has one.
- A label that resolves counts as **skipped**; a label that does not is a **failure** naming the
  posts. Run it with `--dry-run` to list the gaps, add the missing places to the tenant, run again.

`resolveLegacyLocation` / `resolveLegacyLocations` are exported so the job importer (PJ-64) resolves
a job's location the same way.

## CLI

```bash
pnpm wp-import <entity|all> --tenant <slug> [--dry-run] [--limit N]
```

Boots Payload from `apps/cms` (`DATABASE_URL`, `PAYLOAD_SECRET` as for any CMS script), finds the
tenant by slug, runs the entity's importer plus the importers it depends on (or every importer
for `all`), and prints per-importer counts and errors. `--limit` caps rows read per importer.
Exit codes: `0` ok, `1` some rows or importers failed, `2` bad usage (unknown entity or tenant).

Add an importer to `src/registry.ts` to make it available. The entry script is
`apps/cms/src/wp-import.ts`.

Before importing taxonomies into a tenant that already has them (a hand-made one, say), run
`--dry-run` first: the run matches existing documents by `legacyId` only.

## Requirements for target collections

Each imported collection needs an indexed optional `legacyId` number field and a tenant field
(name configurable with `tenantField`, default `tenant`). `map` returning `null` counts as skipped.
All writes use `overrideAccess: true`.

## Users and organisations (PJ-62)

`pnpm wp-import users --tenant <slug> [--dry-run]` runs `organisations` then `users`.

- **Active rule**: a user is kept when they logged in within 3 years (`last_login` meta), OR
  authored a `job_listing`/`transaction` since 2022-01-01, OR have `jr_alert_status = active`, OR
  are an administrator/editor. Both date bounds are inclusive. Options on `usersImporters()`:
  `activeLoginYears`, `activeJobsSince`, `keepPageVisibility`, `organisationsSlug`, `usersSlug`.
- **Roles**: administrator/editor → tenant `tenant-admin`; `job_lister`/`recruiter` → `employer`;
  `job_seeker`/`contributor` → `seeker`. Other roles are skipped.
- **Organisations**: each kept employer joins an organisation named by their `nickname`;
  employers with the same normalised name share one, and the lowest legacy user id owns it.
  `can_pay_by_bank_transfer` (a present row) → `canPayByInvoice` (the "trusted" flag).
- **Passwords**: `user_pass` goes to `legacyPasswordHash`; users are created through the database
  adapter without a Payload password and sign in through the PJ-34 verifier. A re-run refreshes
  names only (credentials, role and organisation are create-only).
- **Report**: the dry run prints users read/kept, skipped by reason, and organisations merged.
  No emails, names or hashes are logged.
- Not imported: applications, CVs, resumes, logs, `user_IP`, logos/cover images (PJ-63, see below), Yoast
  SEO fields and physical location (no fields on organisations yet).

## Media, logos and PDFs (PJ-63)

```bash
pnpm wp-import-media --tenant <slug> --source <uploads-dir> (--target-dir <dir> | --r2-local) [--dry-run] [--verify]
```

Copies the legacy files that **imported records** use, then links them. Run it after the
organisation importer, and again after the job (PJ-64) and page (PJ-67) importers: records that
do not exist yet are skipped (`owner-not-imported`, and their file is not copied), so a later run
picks them up. `--source` is a **copy** of `wp-content/uploads` on disk, never the live server.

| Legacy reference | Becomes |
|---|---|
| user meta `company-logo` (attachment id, or an uploads URL/path), first member of the merged organisation that has one | `organisations.logo` (a `media` document) |
| user meta named by `coverMetaKey` (none by default: the legacy site has no cover key) | `organisations.cover` |
| a document attachment (PDF, DOC, DOCX) whose parent is a job; the newest wins | `jobs.jobDescriptionPdf` (a `documents` document, max 10 MB) |
| page featured image, else the Yoast share image | `pages.seo.image` |

- **Stable names**: the bucket key and the document `filename` are `t<tenant>-<12-char hash of the
  legacy path>-<legacy path flattened with '-'>` (`t1-3f9a0c1b2d4e-company_logos-12-logo.png`). The
  storage adapter serves files by one path segment, hence the flattening; the hash keeps two paths
  that flatten alike apart (`my logo.png` / `my_logo.png`), and the tenant keeps tenants apart in
  the shared bucket. Derived from the inputs alone, so a re-run, or a second record that uses the
  same file, lands on the same object, and no two files are ever written to one object. The
  document's `legacyId` is the attachment id (a file that is only a path gets a stable negative id).
- **Resumable and idempotent**: the bucket is the only state. An object that exists with the
  right size counts as copied (`--verify` re-hashes the source and compares the stored SHA-256).
  Stores write nothing under the key until the checksum matches, so a killed run leaves no partial
  object. A relation is set only when empty; another file chosen by a person is left alone.
- **Verified**: the source is hashed, streamed with that SHA-256 and size (R2 and the directory
  store reject a mismatch), and the stored size is read back.
- **Never imported**: generated thumbnails (a URL that names one maps back to its original),
  `uploaded_cvs`, `wp-staging`, `at-logs` (`excludePaths`), image variants (decision 5), and a job's
  own featured image (its logo is the organisation's). Documents over `maxDocumentBytes` (10 MB,
  the collection's cap) are skipped and reported.
- **Report**: references found, files and bytes copied or already in place, documents created,
  relations set or left, skipped by reason, failures with owner and path. Exit code 1 on failures.
- **Targets**: `--target-dir` writes to a local directory; `--r2-local` writes to wrangler's local
  R2 emulation (binding `MEDIA`). Neither touches the real bucket. Copying into `mission-control-media`
  is a founder-run step with `r2Target(binding)`, which streams where workerd allows it.
- Not covered: images embedded in page body text (the page importer, PJ-67, rewrites those URLs).

## Jobs (PJ-64)

`pnpm wp-import jobs --tenant <slug> [--dry-run]` runs everything a job needs first (taxonomies,
users, organisations) and then `job-organisations` and `jobs`. Run `wp-import-media` afterwards:
it links `jobDescriptionPdf` to jobs that now exist.

- **Which jobs**: `job_listing` posts with status `publish` or `expired`. Drafts, pending and
  trash are skipped and counted by status in the report.
- **Organisation**: the job's `_Company` name, matched (same normalisation as PJ-62) to an
  organisation from the users import. Admins post about two thirds of the jobs with the real
  employer in `_Company`, so a name with no organisation becomes one (`job-organisations`:
  approved, page private, `legacyId` = minus the lowest job id of that name). A job with no
  `_Company` uses its author's organisation; with neither it is skipped (`no-organisation`).
  `companyName` is kept only when it differs from the organisation's name.
- **Description**: `post_content` is converted once to Lexical (`html-to-lexical.ts`): paragraphs,
  headings (`h2`–`h4`), bold, italic, lists, line breaks and links to http/https/mailto/tel. Scripts,
  styles, frames, images, event handlers and every other link protocol are removed. Plain text is
  split like WordPress did (blank line = paragraph). `how to apply` is plain text.
- **Slugs** keep the legacy `post_name`; one that equals a category, location or job-type slug (or a
  reserved word) gets `-2`, `-3`, … (decision 19 Nov).
- **Taxonomies** are linked through `wp_term_relationships` after the 19 Nov clean-up: `Independant`
  folds into `Independent`, the 1–1.5M and 1.5–2M salary bands into 1–2M, and the broken salary
  terms `000`, `000 or more`, `1`, `2` are dropped (the job gets no band). The leftover legacy terms
  still exist in the taxonomy collections (PJ-61 imports them all) for a site manager to remove.
- **Locations**: one or many chips from `_jr_address` (else `geo_short_address`, `geo_address`) by
  `job-locations.ts`: `Town, Island` pairs, `Efate,Port Vila`, `and` / `&` / `;` / ` - ` separators,
  one-letter typos, and provinces expanded to islands (an option; vwok default). A place is dropped
  when one of its descendants is also a chip. The original text is kept as `locationDetails`
  unless the chips say exactly what it said.
- **Dates**: `publishedAt` from `post_date_gmt`. `expiresAt` = published + the employer's close days
  (`_jr_fx_expire_days`), else the plan duration (`_jr_job_duration`), else 30; an expired job that
  was ended early (`user_ended`, `user_canceled`, …) closes when it was last modified. Expired jobs
  keep their dates, so the 12-month 410 rule works.
- **Featured**: `_jr_featured-listings` → a `featured-in-listings` placement from its start date for
  its paid duration (until close when none). Placements that already ended are not imported (the
  daily clean-up removes them). `featured-in-category` is not seeded (`featuredInCategory` option).
- **Views**: `wp_jr_counter_total` (`postnum`, `postcount`) when the table exists, else the
  `jr_total_count` meta. A re-run never lowers the counter.
- **Other fields**: `_displayed_salary` as text, `jr_fx_apps_recipient_address` →
  `applicationsRecipient`, `jr_fx_disable_apply_online` → `applyOnline`, `_CompanyURL`.
  Never read: `user_IP`, applications, `_edit_lock`.
- **Created through the adapter** (`rawCreate`): the status state machine refuses to create an
  expired job. Re-runs use `payload.update` with the view-counter context.
- **Localization**: `rawCreate` skips Payload's locale handling, so the runner wraps each localized
  field (`title`, `description`, `howToApply`, …) in the default locale when localization is on.
- **Re-runs are for before cutover.** A re-run refreshes every imported field from the legacy site
  (status, dates, slug, placements, title), so after cutover it would overwrite edits made in the
  new system. Only the view counter is protected (it never goes down).
- **Snapshot assumptions**: a company organisation's `legacyId` is minus the lowest job id of that
  name, stable while the source does not change between runs. Import the locations tree (seed) before
  the jobs: a tenant with none imports every job without location chips and nothing fails; the
  dry run shows `location: unmatched`.
- **Report** (dry run and real run): counts per status, job type, salary band, category, location
  outcome, slug suffixes, dropped terms, featured placements, views and skip reasons.

## Not covered yet

- Geo coordinates (`_jr_geo_latitude/longitude`): the jobs collection has no field for them.
- In a dry run, documents created by an earlier importer do not exist, so a mapper that resolves
  relations by `legacyId` sees them as missing.
- The legacy taxonomy keys for `job-cat`/`job-tag`/`areas-of-focus` are read from AUDIT.md; the
  legacy plugin source is not in this repo. Check the imported counts against the live term
  counts before cutover (PJ-68 does the same comparison).

## Plans, coupons, orders and credits (PJ-65)

`pnpm wp-import orders --tenant <slug> [--dry-run]` runs `jobs` and `plans` first (and what they need);
`coupons` and `credits` run on their own. Orders and credits need the organisations (PJ-62) and the jobs
(PJ-64) to exist. Options on `commerceImporters()`: `importExpiredCoupons`, `orderMonths`, `orderMeta`,
`paymentProvider`, `currency`, `slugs`, `tenantsSlug`, `siteUtcOffsetMinutes`.

- **`plans`** writes nothing. The plans are seeded (`apps/cms/src/seed/vwok-plans.ts`); this compares each
  published `pricing-plan` post with the seeded plan of the same `legacyId` (price, relist price = price,
  duration, pack size). A difference or a missing plan is a failure that names it. Unpublished plans are skipped.
- **`coupons`** imports the `discount_coupon` posts that have not expired (LINKPS stays; 19 Nov decision).
  Flat amounts are minor units, percentages whole numbers, `use_limit` 0 is unlimited. The use count is
  written when the coupon is created and never again, so a re-run cannot lower what the live site counted.
- **`orders`** imports `transaction` posts of the last 24 months. `tr_pending` → `invoiced`, `tr_activated` /
  `tr_completed` → `paid` (paid date = the post's last modified), `tr_failed` → `failed`; anything else is
  skipped. Money is whole minor units, no tax (an order with a `tax_charge` fails rather than losing it).
  The order belongs to the organisation of the job it paid for (P2P `order-connection`), else of the buyer;
  the plan is the connected `pricing-plan`; `_xero_invoice_id` becomes an external reference (provider `xero`).
  What the order was sold for is written once, at creation. PayPal data and order logs are never read.
- **`credits`** writes one `opening` ledger row per `_jr_user_pack-*` user meta with credits left, attached to
  the buyer's organisation, no expiry, with the legacy reference `wp-user-pack:<user id>:<meta key>`. Rows are
  matched by that reference (the ledger has no `legacyId` and is append-only), so a re-run adds nothing.
- **Dry run report**: orders by month, by status and the total; coupons imported and expired with each use
  count; opening credits per legacy organisation and in total.

The legacy meta key names are in one place (`LEGACY_ORDER_META`, `PACK_META_PREFIX`) and follow AppThemes
Payments and JobRoller. Confirm them with a dry run against the live copy: a row whose total or pack balance
cannot be read is counted and named, never guessed.

## Sync mode (PJ-121)

`pnpm wp-import sync --tenant <slug> [--dry-run] [--refresh-credentials] [--apply-deletions]` runs
every importer in dependency order and prints a summary, to keep a tenant current while the legacy
site is live. A second run creates nothing: it updates or skips.

- **Re-runs overwrite.** Fields an importer maps are rewritten on every run, so edits made to
  imported documents in the new site are lost. Sync is for the pre-launch period only. Create-only
  fields (written once, never refreshed): a user's `email`, `role`, `tenants`, organisation and
  organisation role, verified flag and login attempts, and the legacy password hash (see below); a
  coupon's use count; a job's featured `placements`. Ledger-style collections (`matchBy`) are
  never updated.
- **Removals are reported, never applied by default.** Imported documents (with a `legacyId`, in
  the run's tenant) whose legacy row is gone or trashed are listed. With `--apply-deletions`, an
  importer's `removal` policy runs (`jobs`: a published job becomes `expired`, which can be relisted when the job comes back on the legacy site; a cancelled job could not). Nothing is hard-deleted,
  and orders, the credit ledger and users have no policy, so they are never touched. Nothing is
  checked for an importer whose read was incomplete (no rows, a failed row, a skipped row without a
  `legacyId`, an aborted read). A skipped row can return `{ skip, legacyId }` (its earlier import is
  treated as removed) or `{ skip, legacyId, keep: true }` (data problem, the earlier import stays).
- **`--refresh-credentials`** replaces a user's legacy password hash while the user has not signed
  in (signing in clears it). It is never brought back afterwards, and an empty hash never blanks a
  stored one.
- **Removed users stay removed.** A person whose personal data was removed (PJ-89) keeps an
  anonymised row with their legacy id as a tombstone; the users importer skips them (`anonymised`)
  and never re-creates them, even while WordPress still has the account. The tombstone is matched
  by legacy id alone (the removal clears the tenant link), so a second legacy site importing into
  another tenant must not reuse ids.
- Credential refresh also skips a user who has their own Payload password (`hash`).
- Removal updates carry the context `{ wpImportSync: true }` so hooks can tell them from staff actions.
- `--limit` is refused with `sync`. Logs carry collection, ids and the change only, no personal data.
- **Not included yet:** media (`wp-import-media` needs the uploads directory) and role/organisation
  change reporting for users.
