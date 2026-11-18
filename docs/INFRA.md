# Infrastructure

IDs only. Secrets live in GitHub Actions secrets (`NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `PREVIEW_PAYLOAD_SECRET`) and as Worker secrets; never put them here.

## Neon

| Item | Value |
|---|---|
| Project | `mission-control` (`silent-wind-78571082`) |
| Region | `aws-ap-southeast-2` |
| Default branch | `main` |
| Database / role | `neondb` / `neondb_owner` |
| Preview branches | `preview/<preview-name>`, cut from `main` when the branch first gets a preview (see below) |

## Cloudflare

| Item | Value |
|---|---|
| Worker (production) | `mc-cms` — https://mc-cms.labcat.workers.dev |
| Worker Previews | `<preview-name>-mc-cms` — `https://<preview-name>-mc-cms.labcat.workers.dev` |
| Hyperdrive config | `mission-control` (`600510da0e1f45958ba5d7c908090a22`) |
| Hyperdrive origin | Neon `main` direct endpoint, query caching disabled |

Production uses the `HYPERDRIVE` binding. Worker Previews get no Hyperdrive binding; they receive a `DATABASE_URL` secret for their own Neon branch.

## Preview lifecycle (`.github/workflows/preview.yml`)

Each preview is a Worker Preview plus a Neon branch `preview/<name>`. `<name>` comes from `.github/scripts/preview-name.sh`. Neon limits how many branches a project can have, so previews must not pile up (PJ-86).

| Event | What happens |
|---|---|
| Push to a branch with an open PR, or a PR is opened/reopened | Preview is published. The Neon branch is created once and kept, so test data survives later pushes. |
| Push to a branch with no open PR | Nothing. The `gate` job skips the preview. Opening the PR creates it. |
| RC tag | `preview/rc-<version>` is recreated from prod. `release.yml` deletes it on release. |
| PR closed or merged, or git branch deleted | `cleanup` job deletes that branch's Worker Preview and Neon branch. |
| Daily at 03:17 UTC, or manual | `sweep` job deletes every stale `preview/*` Neon branch and its Worker Preview. |
| Creating a branch would hit the limit | The job fails early and lists the existing `preview/*` branches. |

The branch limit defaults to 10. Set the repository variable `NEON_BRANCH_LIMIT` to match the Neon plan.

### The sweep

A preview is **stale** when no open PR from this repo has its branch name. The sweep never deletes:

- `main`, or any branch that isn't `preview/<name>`. The rule is strict: `preview/` followed by a lowercase DNS label of at most 40 characters.
- `preview/rc-*`. RC previews belong to the release flow.
- A branch Neon marks primary, default or protected.

It stops without deleting if the Neon list has no `main` or the open PR list could be truncated. The rules live in `.github/scripts/preview-neon.mjs` and are tested in `preview-neon.test.ts` (`pnpm test`). Every delete in `preview.yml` first passes the branch through `preview-neon.mjs valid`.

Manual runs default to a **dry run** that only lists what it would delete (also in the run summary). To clean up the current backlog, dry run first, then delete:

```bash
gh workflow run preview.yml --repo LABCAT/mission-control -f dry_run=true
gh workflow run preview.yml --repo LABCAT/mission-control -f dry_run=false
```

`workflow_dispatch` only works once this workflow is on `main`.
