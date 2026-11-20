# Hisha run, 20 Nov: handover to the cloud agent

The run stopped early, at the founder's request. All work is pushed: nothing is left only on a local machine. The rules from the run brief still apply:
- at most 9 open PRs, and merge before sending more;
- one ticket = one branch = one PR;
- no force-push and no rebase;
- migration last, one migration PR at a time; wait for the production deploy before the next;
- merge only when all checks are green and Kinsho is pass or needs-evidence, using the full head SHA;
- never run migrations against Neon.

## Merged (6)

| PR | Ticket | Notes |
|---|---|---|
| #69 | PJ-13 apps/vwok | was already green |
| #63 | PJ-26 alert subscriptions on tenant delete | merged `main` (one test-helper conflict) |
| #71 | PJ-110 payload-cloudflare-analytics | review fix: endpoint limited to admin-collection users |
| #70 | PJ-111 viewed jobs (localStorage) | 1,275 B min+gzip; Lighthouse 100 / CLS 0 measured locally with provided throttling |
| #72 | PJ-117 features catalogue | 143 stories; `scripts/features/report.mjs`; CI step in mc-checks |
| #74 | PJ-84 rocketship-payload blocks (incl. Banner) | Kinsho fix: `safeHref` rejects `javascript:`/`data:`/protocol-relative links |

## Open PRs (7), and what each needs, in order

1. **#40 PJ-22 coupons (migration, next to merge).** Branch `openhands/pj-22-coupons` @ `dbc8c55`.
   - The merge with `main` is done, and the migration is recreated on top of main as `PJ-22: coupons migration on top of main`.
   - **Not yet verified:** the agent was stopped before it reported. Check:
     - migrate up/down/up on a scratch DB;
     - that the migration covers only coupons;
     - the full checks;
     - CI and Kinsho on `dbc8c55`.
   - Then merge, and wait for the production deploy.
2. **#21 PJ-76 site-key smoke (migration).** This is a migration PR (tags drafts). After #40 has deployed: merge `origin/main`, recreate `20261118_110701_tags_drafts` on top of main's newest migration (keep the hand-written backfill and the `down()` guard), run the checks, merge, wait for the deploy.
3. **#73 PJ-80 payload-jobs installable (`needs-migration`).** CI is green. Kinsho blocks it only for the missing migration, which is expected.
   - Next migration after #21: merge `origin/main`, generate the migration for removing `job-tags`, `areas-of-focus` and `organisations.areasOfFocus` on its own commit, swap the label to `migration`, then merge.
   - **Merge #73 before PJ-99:** both touch `locations.ts`, `jobs.ts` and `index.ts`.
4. **#75 PJ-112 payload-email-smtp.** Kinsho BLOCKED it: SMTP command injection, because CR/LF in an address reaches `RCPT TO` (`src/xoauth2.ts:114`, `src/address.ts:9`).
   - The fix is half done on **`wip/pj-112-smtp-injection-fix`** @ `bfaef74`. It is untested: one WIP commit on top of the PR head `0d24c5e`.
   - Brief: `daruma/.agents/skills/machine/hisha/briefs/pj-112-payload-email-smtp-rev3.md`. Validate all addresses on both auth paths, strip CR/LF from display names and the subject, and add tests.
   - Finish on the PR branch (`agent/pj-112-payload-email-smtp`; merge or cherry-pick the WIP), run the checks, push, and merge once Kinsho passes.
   - Earlier fixes are already in: Node 24 `toBase64` polyfill, XOAUTH2 (20 Nov decision), case-insensitive Message-ID.
5. **#31 PJ-79: skipped (needs a decision).** `main` added 10 `payload-jobs` modules that import the helpers this PR moves out. Either drop it, or redo it as access injection under PJ-80/PJ-115. Noted on the PR.
6. **#36 PJ-27: skipped.** It conflicts with "email templates (final)" (Lexical plus variable chips, not plain-text `{{placeholders}}`). Noted on the PR; it belongs to PJ-50.
7. **#38 PJ-20: left alone,** as briefed. It needs a rework to system pages (PJ-103).

## Branch without a PR

- **PJ-99 location tree:** branch `agent/pj-99-location-tree` @ `8139dd6`. This is one WIP commit: unfinished, untested, and no migration (needs-migration).
  - Brief: `briefs/pj-99-location-tree.md`. Per the 20 Nov decision, a job has many locations plus an optional `locationDetails`.
  - Finish it, open a PR with the `needs-migration` label, and merge it after #73.

## Tickets sent this run (claimed on D1: `dispatch_status=dispatched`, `in_progress`)

| Ticket | Status |
|---|---|
| PJ-117 | merged (#72) |
| PJ-84 | merged (#74) |
| PJ-80 | open (#73) |
| PJ-99 | WIP branch |
| PJ-110, PJ-111, PJ-112 | in-flight from 19 Nov; merged, merged, open |

Not sent, because the founder said no new sessions until everything outstanding is merged:
- PJ-118 (Xero payment sync). It has no `prompt` on D1, only a description.
- PJ-25, PJ-37, PJ-62, PJ-30.
- The unblocked list: PJ-98, PJ-103, PJ-115, PJ-63, PJ-88.

**D1 board to update:** set PJ-13, PJ-26, PJ-110, PJ-111, PJ-117 and PJ-84 to done.

## Gotchas found this run

- **Neon preview limit:** when there are too many open PRs, "Publish preview" fails ("Neon branch limit reached") and Admin smoke is cancelled. Merging frees branches (`delete_branch_on_merge` is on), then re-run the failed Preview jobs. A cancelled push-triggered Preview run still shows red in the PR rollup; the `pull_request` run is the one that counts.
- **Kinsho reviews only ready PRs** (it skips drafts), so mark agent PRs ready.
- **Agent permission prompts stall runs silently:** reading `/tmp`, or a mistyped absolute path outside the worktree. Tell agents to use relative paths and to stay inside the worktree.
- **Hisha dispatcher** (daruma) now creates sessions through `openchamber session create|send`, so they show in OpenChamber, and prints `SESSION`/`PROGRESS`/`PERMISSION` lines. That part is on daruma `main` (`e6a1d7c`).
  - Unmerged daruma branch **`hisha/dispatch-timeout-recovery`** (`2605112`) recovers sessions when the OpenChamber CLI times out after 4 seconds on a new directory, and rejects `--session null`. It needs a PR or merge in daruma.
- **Separate test databases per agent:** `orbit_test_a` to `orbit_test_e`, `orbit_test_pr31`, `orbit_test_pr63`, and `orbit_mig` for generating migrations. Parallel agents must not share `orbit_test`.
