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
- Not imported: applications, CVs, resumes, logs, `user_IP`, logos/cover images (PJ-63), Yoast
  SEO fields and physical location (no fields on organisations yet).

## Not covered yet

- Job → term links (`wp_term_relationships`) belong to the job importer (PJ-64).
- In a dry run, documents created by an earlier importer do not exist, so a mapper that resolves
  relations by `legacyId` sees them as missing.
- The legacy taxonomy keys for `job-cat`/`job-tag`/`areas-of-focus` are read from AUDIT.md; the
  legacy plugin source is not in this repo. Check the imported counts against the live term
  counts before cutover (PJ-68 does the same comparison).
