# Infrastructure

IDs only. Secrets live in GitHub Actions secrets (`NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `PREVIEW_PAYLOAD_SECRET`) and as Worker secrets; never put them here.

## Neon

| Item | Value |
|---|---|
| Project | `mission-control` (`silent-wind-78571082`) |
| Region | `aws-ap-southeast-2` |
| Default branch | `main` |
| Database / role | `neondb` / `neondb_owner` |
| Preview branches | `preview/<preview-name>`, cut from `main` on first push |

## Cloudflare

| Item | Value |
|---|---|
| Worker (production) | `mc-cms` — https://mc-cms.labcat.workers.dev |
| Worker Previews | `<preview-name>-mc-cms` — `https://<preview-name>-mc-cms.labcat.workers.dev` |
| Hyperdrive config | `mission-control` (`600510da0e1f45958ba5d7c908090a22`) |
| Hyperdrive origin | Neon `main` direct endpoint, query caching disabled |

Production uses the `HYPERDRIVE` binding. Worker Previews get no Hyperdrive binding; they receive a `DATABASE_URL` secret for their own Neon branch.
