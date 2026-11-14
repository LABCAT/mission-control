# AGENTS.md – mission-control

Read this before doing anything. Task prompts come from the Daruma board (project **Payload Jobs**, `PJ-*`); the full plan is in `docs/migration/`.

## Setup (macOS / Linux)

```bash
fnm use                      # Node from .node-version (24.22.x). Wrong Node = engine warnings + odd failures
pnpm install
docker compose up -d         # Postgres on localhost:8900 (orbit/orbit/orbit)
docker compose exec postgres createdb -U orbit orbit_test # once, for isolated integration tests
cp apps/cms/.dev.vars.example apps/cms/.dev.vars   # then set PAYLOAD_SECRET to a random string
cd apps/cms && DATABASE_URL=postgres://orbit:orbit@localhost:8900/orbit PAYLOAD_SECRET=dev pnpm payload migrate
pnpm dev                     # from repo root; admin at the printed localhost URL + /admin
```

## Checks (all must pass before a PR)

```bash
pnpm typecheck && pnpm lint && TEST_DATABASE_URL=postgres://orbit:orbit@localhost:8900/orbit_test pnpm test && pnpm --filter cms build
```

Tests that push Payload schema require `TEST_DATABASE_URL` to point to a disposable database; do not use the CMS development database.

Each `bootTestPayload` call pushes into its own throwaway schema (`mc_test_*`) and drops it on teardown, so one test database serves the whole suite and drizzle never offers one test's tables as a rename of another's.

CI is `.github/workflows/mc-checks.yml`. Don't edit orbit's `ci.yml` or `release.yml`.

## Schema changes and migrations

Dev schema push is **off** (drizzle-kit can't run in workerd), so every collection, field or global change needs a migration.

1. Change the config, then regenerate the types:
   ```bash
   cd apps/cms
   DATABASE_URL=… PAYLOAD_SECRET=dev pnpm generate:types
   ```
2. With the local DB migrated to the latest version, create the migration:
   ```bash
   pnpm payload migrate:create <short_name>
   ```
   Then apply it with `pnpm payload migrate`, and check that `pnpm payload migrate:down` reverts it cleanly.
3. Commit the migration on its **own commit**, and add the `migration` label to the PR.
4. If you need to redo a migration, migrate it down first. Then delete its `.ts`/`.json` files, remove it from `migrations/index.ts`, and create it again. Never edit a migration that's already on `main`.
5. Never run migrations against Neon. Releases do that.

## Payload 4 beta gotchas (learned the hard way)

- **Globals and collections get versions by default.** Set `versions: false` unless you need history. Otherwise you get extra `_v` tables.
- **The jobs local API checks access.** System code (cron, hooks) must pass `overrideAccess: true` to `payload.jobs.run`. Cron calls have no user.
- **Scheduled tasks:** `schedule[].cron` uses 6 fields (seconds first). `handleSchedules` queues the job for the *next* matching time, and a later tick runs it.
- **Password hashing:** Workers rejects PBKDF2 above 100k iterations. Keep `auth.passwordHashIterations: 100000`.
- **Hyperdrive:** read it through the getter in `payload.config.ts`, and never at module scope. Keep `maxUses: 1`.
- **Workspace packages are TS source** (`exports: ./src/index.ts`). This works for both the Vite build and the `payload` CLI, with no build step.
- **Types:** after changing the config, regenerate `payload-types.ts` before typechecking.

## Testing a Worker cron locally

With `pnpm dev` running:
```bash
curl "http://localhost:<port>/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```
Errors show up in `POST /cdn-cgi/local/explorer/api/local/observability/query` with `{"sql":"SELECT * FROM logs ORDER BY rowid DESC LIMIT 10"}`.

## Git and PRs

- **`gh` defaults to this repo**, but the clone has two remotes. Pass `--repo LABCAT/mission-control` if `gh` complains.
- **Never push to `upstream`** (orbit). See `docs/UPSTREAM.md`.
- **One task per branch and per PR, based on `main`.** Don't stack PRs on other unmerged branches: a stacked PR gets merged into the wrong base.
- **A merge to `main` deploys to production and runs migrations.** PRs labelled `migration` are always merged by the founder.
- **PR body:** the task slug, what changed, how you checked it, and any migration.

## Boundaries

- **Job-board code** goes in `packages/*` and new `apps/*`. Edit orbit's files in `apps/cms` only as much as you have to, and mark the edits with `// mission-control:`.
- **UI:** Rocketship first (`@labcat2020/rocketship`). A missing generic component belongs in `LABCAT/rocketship`: flag it in the PR and don't build it here.
- **Pinned versions:** match orbit's Payload beta exactly.
- **No secrets** in code, docs or logs.
- **Escalate instead of guessing:** spending money, production secrets, DNS, running migrations on Neon, and anything to do with deleting data.
