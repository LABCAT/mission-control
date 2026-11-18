# PJ-70 – URL parity crawler (tool only)

Repo: LABCAT/mission-control. Branch: `pj-70-url-parity` from `main`. One PR.

Goal: a CLI that proves every public legacy URL on vanuatuwok.vu either works on the new site or 301s to the right place. Built now, run at cutover.

Do
- New folder `tools/url-parity/` (plain TypeScript run with `node --experimental-strip-types` or tsx if already in the repo; no new deps if avoidable). Do not touch `apps/` or `packages/`.
- Input: legacy sitemap URL (`https://vanuatuwok.vu/sitemap_index.xml` or `/sitemap.xml`, follow sitemap indexes) and a target base URL. Optional `--map <file>` JSON of expected redirects.
- For each legacy path: request target with redirects off; classify 200 / 301→expected / 301→wrong / 404 / other. Concurrency limit (default 4), polite delay, a User-Agent of `url-parity-check`.
- Output: summary table to stdout and a CSV report; exit code 1 if any 404 or wrong redirect.
- Tests (vitest, already in the repo): sitemap index parsing, classification, redirect map matching – with fixture XML, no network.
- Read `docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md` for known URL shapes. No personal data in fixtures.

Done: `pnpm -r typecheck lint test` pass; README in the folder with the exact command.
