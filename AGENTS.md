# AGENTS.md – mission-control

Read this before doing anything. Task prompts come from the Daruma board (project **Payload Jobs**, `PJ-*`); the full plan is in `docs/migration/`.

## Setup (macOS / Linux)

```bash
fnm use                      # Node from .node-version (24.22.x). Wrong Node = engine warnings + odd failures
pnpm install
docker compose up -d         # Postgres on localhost:8900 (orbit/orbit/orbit)
cp apps/cms/.dev.vars.example apps/cms/.dev.vars   # then set PAYLOAD_SECRET to a random string
cd apps/cms && DATABASE_URL=postgres://orbit:orbit@localhost:8900/orbit PAYLOAD_SECRET=dev pnpm payload migrate
pnpm dev                     # from repo root; admin at the printed localhost URL + /admin
```

## Checks (all must pass before a PR)

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm --filter cms build
```

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

## Admin smoke (required after deploy changes)

The admin is a TanStack Start RSC app. A Worker redeploy keeps the same workers.dev hostname but
replaces the hashed `/assets/*` files. A tab, bfcache entry, or cached HTML from the previous
deployment can point at files that no longer exist, and the admin sits on its loading spinner.

`/api/users/init` returning 200 is **not** an admin smoke test. After a Preview or Deploy run:

1. Open `/admin` in a fresh incognito window, or hard-refresh (Cmd/Ctrl+Shift+R) with the cache
   disabled. Log in and confirm the dashboard, the Tenants list and a create form render.
2. If it still spins, check DevTools → Network for old `/assets/*.js` requests returning 404, and
   clear site data. Reusing a tab opened before the deploy is not a valid test.
3. Admin responses are now `Cache-Control: no-store` (`apps/cms/src/server.ts`), but that cannot
   fix a tab that was already open across a deploy. A hard refresh is still required once.

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
