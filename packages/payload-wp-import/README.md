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

## Requirements for target collections

Each imported collection needs an indexed optional `legacyId` number field and a tenant field
(name configurable with `tenantField`, default `tenant`). `map` returning `null` counts as skipped.
All writes use `overrideAccess: true`.

## Not covered yet

- No importers are registered yet; each entity task adds its own to `src/registry.ts`.
- In a dry run, documents created by an earlier importer do not exist, so a mapper that resolves
  relations by `legacyId` sees them as missing.
