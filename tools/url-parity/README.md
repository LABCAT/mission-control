# url-parity

Checks that every public legacy URL (from the old site's sitemap) either works on the new site or 301s to the right place. Built for the vanuatuwok.vu cutover (PJ-70). No dependencies; uses Node's built-in type stripping.

```bash
node --experimental-strip-types tools/url-parity/src/cli.ts \
  --sitemap https://vanuatuwok.vu/sitemap_index.xml \
  --target https://new.example.com \
  --map redirects.json \
  --out url-parity-report.csv
```

| Flag | Default | |
|---|---|---|
| `--sitemap` | required | Legacy sitemap or sitemap index (indexes are followed) |
| `--target` | required | Base URL of the new site |
| `--map` | none | JSON `{ "/old/": "/new/" }` of expected redirects (paths or full URLs) |
| `--out` | `url-parity-report.csv` | CSV report |
| `--concurrency` | `4` | Parallel requests |
| `--delay` | `250` | ms each worker waits after a request |
| `--strict` | off | Also exit 1 on `redirect-unmapped` |
| `--allow-unverifiable` | off | Accept `other` results (network errors, 302/307, 5xx, legacy title unavailable) instead of failing on them |

Each path is requested with `GET`, redirects off, `User-Agent: url-parity-check` (429/503 are retried honouring `Retry-After`). 301/308 redirects are then followed (up to 5 hops) and must end in a 200. A 200 must have the same `<title>` as the legacy page (compared case/space-insensitively, ignoring a trailing ` » Site name` or ` | Site name`). Results:

- `ok`: 200 and title matches
- `title-mismatch`: 200 but the title differs from the legacy page
- `redirect-ok`: 301/308 to the path in `--map`, destination returns 200
- `redirect-wrong`: 301/308 to anywhere else (or another host), or with no `Location`
- `redirect-offsite`: any hop in the chain leaves the target's origin (that hop is not requested)
- `redirect-broken`: the redirect chain does not end in a 200
- `redirect-unmapped`: 301/308 with no `--map` entry whose destination returns 200 (cannot be proven the *right* place; add it to the map)
- `not-found`: 404/410
- `other`: anything that could not be verified (302/307, 5xx, network error, or legacy title unavailable); fails unless `--allow-unverifiable`

Exit code: `1` on any `not-found`, `redirect-wrong`, `redirect-broken`, `redirect-offsite`, `title-mismatch` or `other`, `2` on bad arguments, or a sitemap that is unreadable, not `<urlset>`/`<sitemapindex>` (e.g. an HTML page) or empty, else `0`.

Tests: `pnpm test`. Type check: `pnpm --filter @mission-control/url-parity typecheck`.
