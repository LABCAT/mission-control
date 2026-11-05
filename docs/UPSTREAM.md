# Keeping in sync with orbit

`mission-control` is downstream of `LABCAT/orbit`. It isn't a GitHub fork, because GitHub doesn't allow forking within the same account, so it's a separate repo carrying orbit's full history.

| Remote | Repo | Push |
|---|---|---|
| `origin` | `LABCAT/mission-control` | yes |
| `upstream` | `LABCAT/orbit` | disabled in this clone |

## Pull in orbit changes

```bash
git fetch upstream
git switch -c upstream-sync/$(date +%F) main
git merge upstream/main
# resolve conflicts, run checks, open a PR into main
```

`.github/workflows/upstream-sync.yml` does this every Monday morning (NZ time), and can be run by hand from the Actions tab. It opens a PR named `Sync from orbit (<sha>)`. If the merge conflicts, it opens an issue listing the conflicting files instead.

The workflow needs a repo secret **`ORBIT_READ_TOKEN`**: a fine-grained PAT with read access to the contents of `LABCAT/orbit`, because orbit is private.

## What goes where

**orbit:** anything generic to "Payload 4 + TanStack on Workers + Neon", such as:
- Workers and Hyperdrive fixes
- auth settings
- the base collections (Users, Media, Folders, Tags)
- CI and release workflows
- dependency bumps

**mission-control:** anything to do with jobs or tenants:
- `packages/*`
- `apps/hub`, `apps/vwok` and future site apps
- the multi-tenant config in `apps/cms`
- `docs/migration`

## Rules that keep merges clean

- **CI:** our checks are in `.github/workflows/mc-checks.yml` (runs on PRs). Orbit's `ci.yml` and `release.yml` aren't edited here.
- **Root files:** `package.json` and `pnpm-workspace.yaml` carry small additions (the `packages/*` workspace and the root scripts). Expect minor conflicts there when orbit changes them.

- **Fixes to orbit's files:** fix them in orbit, then sync them across. Don't edit them here.
- **Extending `apps/cms/src/payload.config.ts`:** keep the changes small. Plugins are registered in one block; collections and logic live in packages.
- **Migrations:** never edit orbit's migrations. Our migrations come after them.
