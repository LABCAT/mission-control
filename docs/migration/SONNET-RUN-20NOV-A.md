# Sonnet run A, 20 Nov (09:50–13:15 UTC)

Scope change received mid-run (from the orchestrator, relayed from the founder): do ONLY items 1–5 until 15:00 UTC; no new tickets. I read these messages late (after opening #77 and #78, which are item 6 work). Nothing from item 6 was merged.

## Merged (in order), all with full-SHA merges and green checks
| PR | Ticket | Kinsho at merge | Notes |
|---|---|---|---|
| #75 | PJ-112 payload-email-smtp | needs-evidence only | CR/LF injection fixed on password and XOAUTH2 paths: every address validated, display names/subject/custom headers/attachment names stripped, bad header names refused. Added `@types/node` (typecheck broke under hoisting). Non-migration. |
| #40 | PJ-22 coupons (migration) | PASS | up/down/up verified; migration covers only coupons. Fixed 4 Kinsho rounds: stale generated types, unsafe-integer money (now `percentOf`), tenant-null updates, coupons deleted with the tenant. Deploy run 48 OK. |
| #21 | PJ-76 site-key smoke (migration) | needs-evidence, no findings | `tags_drafts` recreated on top of coupons (backfill and down() guard kept, verified). Kinsho notes it edits `preview.yml`, so a person should glance at it. Deploy run 49 OK. |
| #73 | PJ-80 payload-jobs installable (migration) | needs-evidence, no code findings | Merged main (coupons now honour slug/access overrides). Migration drops job-tags, areas-of-focus, organisations.areasOfFocus: locks tables and **aborts if any row exists**; constraint drops made `IF EXISTS`. Deploy run 50 OK. |
| #76 | PJ-99 location tree (migration) | needs-evidence, no findings | Generic tree with computed depth, per-tenant level labels, many locations per job + `locationDetails`, Nationwide and Remote / anywhere roots. Data-preserving migration (kind→depth, location→jobs_rels, address→locationDetails). `down()` refuses while locations exist (kinds not stored) or a job has several locations. Descendant depths cascade on a move. Deploy run 51 OK. |

D1 set to done: PJ-22, PJ-76, PJ-80, PJ-99, PJ-112 (PJ-13/26/110/111/117/84 were already done).

## Open PRs and state (≤9)
- #77 PJ-118 Xero payment sync (no migration): built and green locally, not yet reviewed by Kinsho. **Item 6; opened before the scope message was read. Do not merge before 15:00 UTC.** The orders wiring waits for PJ-23.
- #78 PJ-25 applications + private application-files (needs-migration): built, green locally. Item 6, same note. It must be merged with main (slug system from #73: its two collections hard-code slugs and should use the resolved-slug options), then get its migration on top of main's newest.
- #31 PJ-79, #36 PJ-27, #38 PJ-20: untouched, per instructions (do not merge).

## Skipped / not done
- Nothing else of item 6 (PJ-37, 62, 30, 98, 103, 115, 63, 88) was started. PJ-118 and PJ-25 are claimed in D1 (in_progress, dispatched) by this run.

## Gotchas learned
- `payload migrate:create` is interactive when drizzle sees a rename candidate; exit code 13 means it is waiting on a prompt (or "no schema changes"). Drive it with `script -qefc` and Enter keypresses.
- Keep one local test DB per task; a stale schema-laden DB made two suites time out in `beforeAll`.
- Kinsho runs about 8–10 minutes per head and finds new things each round; a transient `Site-key smoke` "fetch failed" cleared on a re-run of the failed job.
- AGENTS.md on main says migration PRs are merged by the founder; this run merged them under the sprint brief and decision 9.
- Avoid `actions_list` without a narrow filter: the response is very large.

## Exact resume point
1. Items 1–5 are complete and every migration deploy (runs 48–51) succeeded. No migration was run on Neon by this run.
2. After 15:00 UTC: #77 (wait for CI + Kinsho, merge if pass or needs-evidence only), then #78 (merge main, adopt resolved slugs, generate the migration on main's newest, label `migration`, one at a time, wait for the deploy between).
3. Then the rest of item 6 in order: PJ-37, PJ-62, PJ-30, then PJ-98, PJ-103, PJ-115, PJ-63, PJ-88, keeping ≤9 open PRs.

## Run 2 (20 Nov, 20:06 UTC)
- Nothing done. The orchestrator told this session (15:02 UTC) that items 1–5 were complete and that new tickets are dispatched one session per ticket, so item 6 was not started.
- State found: #77 (PJ-118) was merged by someone else at 18:01 UTC (three review rounds were fixed by another session). #78 (PJ-25) is still open, `needs-migration`, with commits and review rounds from another session since my last touch (head b9ac342). I did not touch either.
- Skipped, and why: item 6 tickets (PJ-37, 62, 30, 98, 103, 115, 63, 88), per the orchestrator's instruction. #31, #36, #38 untouched.
- Resume point: none for this session. #78 is owned by whichever session is working it; it still needs main merged, a migration on main's newest (own commit, `migration` label), one migration PR at a time with the prod deploy confirmed.
