# PJ-60 – WordPress import framework

Repo: LABCAT/mission-control. Branch: `pj-60-wp-import-framework` from `main`. One PR.

Goal: `packages/payload-wp-import`, the base every importer (PJ-61..67) plugs into.

Do
- New package `packages/payload-wp-import` (match `packages/payload-jobs` tooling: tsconfig, vitest, lint scripts). No edits to `packages/payload-jobs` or `apps/cms` beyond nothing – registering in the cms comes later.
- `MysqlReader`: read-only connection (mysql2, pinned exact; `npm view mysql2 version`), table prefix option (default `wp_`), streaming/paged selects. Connection string from env `WP_IMPORT_MYSQL_URL`; document in package README + `.env.example` with no values.
- `Importer` interface: `{ name, dependsOn[], read(reader), map(row, ctx), collection }`.
- `runImport({ payload, tenant, importers, dryRun })`: topological order by dependsOn, idempotent upsert by `legacyId` (find by `legacyId` + tenant, then update or create), per-importer counts (created/updated/skipped/failed), dry run writes nothing and prints the counts.
- Errors per row are collected, not fatal; summary at end.
- Tests: ordering, idempotency (second run = 0 created), dry run no writes, failure collection. Use an in-memory fake payload + fake reader; no real MySQL in tests.
- Never connect to production. No PII in fixtures (fake names, example.com emails).

Done: `pnpm -r typecheck lint test build` pass. PR body: what changed, how verified, "Part of PJ-60".
