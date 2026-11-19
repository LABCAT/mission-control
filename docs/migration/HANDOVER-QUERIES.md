# Handover: run the vwok WordPress queries (19 Nov)

**Goal:** run the read-only SQL in `docs/migration/QUERIES-19NOV.sql` against the vanuatuwok.vu WordPress database and save the results so the sprint orchestrator can make decisions from them.

## Where to run
- Run in your local **vanuatuwok.vu** checkout (Bedrock). DB connection details are in its `.env` (`DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PREFIX`). Never print, commit or paste them.
- Get the queries from GitHub: `LABCAT/mission-control`, branch `sprint/status`, file `docs/migration/QUERIES-19NOV.sql`.

## Rules
- **Read-only.** Only run the SELECT statements in the file, unchanged except for the table prefix if it isn't `wp_`. No INSERT/UPDATE/DELETE/ALTER, no other queries.
- Use a read-only DB user if one exists; otherwise the normal one, SELECTs only.
- **No personal data in the output.** If a result contains email addresses, names of private people, phone numbers or anything secret-looking (keys, tokens, passwords), stop and drop those columns or rows. Query 6 (tax/Xero options) must be scanned for secrets before saving.
- Don't push to any other branch; don't touch the WordPress site.

## Output
- One markdown file: `docs/migration/QUERY-RESULTS-19NOV.md` in `LABCAT/mission-control` on branch `sprint/status`.
- One section per query (`## 1. …` to `## 17.`), each with the result as a markdown table (cap long results at 100 rows and say so), or the error message if it failed.
- Commit with message `docs: vwok query results 19 Nov` and push to `sprint/status` (normal push, never force).

## Done when
All 17 sections exist, the file is pushed, and nothing in it is personal data or a secret. Then tell the founder "query results pushed".
