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

A weekly workflow that opens this PR automatically is planned in PJ-05.

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

- **Fixes to orbit's files:** fix them in orbit, then sync them across. Don't edit them here.
- **Extending `apps/cms/src/payload.config.ts`:** keep the changes small. Plugins are registered in one block; collections and logic live in packages.
- **Migrations:** never edit orbit's migrations. Our migrations come after them.
