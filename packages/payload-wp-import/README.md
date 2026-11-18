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

## Requirements for target collections

Each imported collection needs an indexed optional `legacyId` number field and a tenant field
(name configurable with `tenantField`, default `tenant`). `map` returning `null` counts as skipped.
All writes use `overrideAccess: true`.

## Not covered yet

- The `pnpm wp-import` CLI and registering the importers in `apps/cms` come in later tasks.
- In a dry run, documents created by an earlier importer do not exist, so a mapper that resolves
  relations by `legacyId` sees them as missing.
