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
| `--strict` | off | Also exit 1 on `other` and `redirect-unmapped` |

Each path is requested with `HEAD`, redirects off, `User-Agent: url-parity-check` (429/503 are retried honouring `Retry-After`). Results:

- `ok`: 200
- `redirect-ok`: 301/308 to the path in `--map`
- `redirect-wrong`: 301/308 to anywhere else (or another host)
- `redirect-unmapped`: 301/308 with no `--map` entry (cannot be proven right; add it to the map)
- `not-found`: 404/410
- `other`: anything else (302/307, 5xx, network error)

Exit code: `1` on any `not-found` or `redirect-wrong`, `2` on bad arguments or an unreadable sitemap, else `0`.

Tests: `pnpm test`. Type check: `pnpm --filter @mission-control/url-parity typecheck`.
