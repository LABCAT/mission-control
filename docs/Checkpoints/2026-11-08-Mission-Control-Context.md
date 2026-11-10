# Mission Control context checkpoint – 2026-11-08

Portable context for orchestrator sessions. The snapshot is `LABCAT/mission-control`
`main` at commit `2151c951b1e8b4a4f5c7125a3658e3c0dcf846a6` (2026-11-08), checked
against the files in that commit and the maintained docs below. It records stable
project context only, not current task status.

## Product and sites

Mission Control is a multi-tenant job-board platform on Payload. Vanuatu Wok
(`vanuatuwok.vu`) is the first customer site, moving off WordPress/PHP; it runs
alongside a LABCAT-owned aggregate site (the "hub"). More sites can be sold later,
each as a tenant plus a small site app rather than a separate back end.
Source: `docs/migration/PLAN.md:3`, `docs/migration/PLAN.md:22-31`.

At this commit the tenant seed defines the aggregate "Pacific Jobs"
(`pacific-jobs`) and Vanuatu Wok (`vwok`); the maintained plan calls the aggregate
site the hub.
Source: `apps/cms/src/seed/tenants.ts:28-54`.

## Orbit upstream and ownership boundary

`LABCAT/orbit` is upstream: a generic Payload 4 + TanStack Start CMS on Workers
with Neon via Hyperdrive. Mission Control carries orbit's full history as a separate
repo (same-account GitHub forks are not possible).
Source: `docs/UPSTREAM.md:3`, `docs/migration/PLAN.md:14-15`.

Orbit supplies generic changes. A weekly workflow merges `LABCAT/orbit` `main` into
an `upstream-sync/<sha>` branch and opens a PR named `Sync from orbit (<sha>)`.
Source: `docs/UPSTREAM.md:7-19`, `.github/workflows/upstream-sync.yml:7-9`.

Mission Control owns job- and tenant-specific work: `packages/*`, the site apps,
the multi-tenant config in `apps/cms`, and `docs/migration`. Orbit keeps the
generic base collections, auth settings, CI/release workflows, and dependency work.
Source: `docs/UPSTREAM.md:25-36`.

## Deployment

A push to Mission Control `main` is production: `.github/workflows/mc-deploy.yml`
runs the checks, migrates the Neon production database, deploys the `mc-cms`
Worker, and smoke-tests it. Mission Control does not use orbit's release tags;
orbit's `release.yml` is left unused.
Source: `.github/workflows/mc-deploy.yml:1-8`, `.github/workflows/mc-deploy.yml:56-77`,
`docs/UPSTREAM.md:41`, `AGENTS.md:65`.

## UI and review tooling

Rocketship first: generic UI belongs in `LABCAT/rocketship`; job-board compositions
belong in `packages/launchpad`, which is intended to consume Rocketship components
and map tenant branding only onto `--rs-*` tokens.
Source: `AGENTS.md:71`, `docs/migration/PLAN.md:43-46`,
`docs/migration/TASKS.md:129-136`.

Kinsho is the PR review/evidence tool: `.github/workflows/opencode-review.yml`
uses `LABCAT/kinsho/.github/workflows/review.yml@v0.4.0`, with `Admin smoke`
configured as its runtime evidence check. Source:
`.github/workflows/opencode-review.yml:16`, `.github/workflows/opencode-review.yml:26-27`,
`.github/workflows/preview.yml:120-125`. The v0.4.0 pin was introduced by commit
`aed7aad` (2026-11-07).

## Implemented vs planned at this commit

Implemented:

- `apps/cms` exists and is the only app. It runs Payload `4.0.0-beta.7` with
  TanStack Start on Workers, Neon via a Hyperdrive getter, and the multi-tenant
  plugin with a `tenants` collection. Source: `apps/cms/package.json`,
  `apps/cms/wrangler.jsonc`, `apps/cms/src/payload.config.ts:14-18,67`.
- Multi-tenancy and tenancy modes are present: `payloadJobs({ tenancy: 'multi' })`
  plus `multiTenantPlugin`; `packages/payload-jobs` accepts `multi` and `single`
  modes. Source: `apps/cms/src/payload.config.ts:67`,
  `packages/payload-jobs/src/index.ts:8-18`.
- A Cloudflare cron trigger drives Payload jobs through a Worker `scheduled()`
  handler, with an hourly heartbeat task. Source: `apps/cms/wrangler.jsonc:9-12`,
  `apps/cms/src/server.ts:9-16`, `apps/cms/src/jobs/runScheduled.ts`,
  `apps/cms/src/jobs/heartbeat.ts`.

Planned, not implemented at this commit:

- `apps/hub`, `apps/vwok`, `packages/launchpad`, `packages/payload-xero`, and
  `packages/payload-wp-import` do not exist in the tree. `git ls-tree` at
  `2151c95` lists only `apps/cms` and `packages/payload-jobs`.
- Launchpad is therefore planned, not built. It is intended to use Rocketship,
  but no `packages/launchpad` exists at this checkpoint.
- The site apps and importer/invoicing packages are described in
  `docs/migration/PLAN.md:22-28` as the intended layout, not as current code.

## Freshness limits

- Use this file only as a snapshot of project structure and rules at `2151c95`.
  For live work state use the Daruma board (project Payload Jobs) and
  `docs/migration/TASKS.md` in the checkout under review.
- `docs/HANDOVER-2026-11-05.md` is older and includes status notes that have since
  moved on (for example, it presents multi-tenancy as a next step; PJ-06 merged on
  2026-11-08 as `53ed92a`).
- Deliberately excluded: machine-local checkout paths, branch state, secrets,
  task counts, and inferences not backed by the cited files.
