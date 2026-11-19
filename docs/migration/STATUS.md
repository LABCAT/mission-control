# Sprint status: Payload Jobs, week of 16 Nov 2026

Orchestrator: session_01H9XNhzozJtHHbbc8KMd38e (replaces session_01H9XNhytrTqfZdgCvKNP79m). Handover Mon 23 Nov.

## Running / in review

| Ticket | Session | Branch | State | Cost |
|---|---|---|---|---|
| PJ-34 WP password verifier | session_01H9XNhy2hU9XoAoarqxAoDP | pj-34-legacy-passwords | PR #41: CI green; Kinsho blocked (hook not wired, PHP trim) → fixing | $0.42 |
| PJ-60 WP import framework | session_01H9XNhzHksGv6x3guC2Y9cE | pj-60-wp-import-framework | PR #42: CI green | $0.63 |
| PJ-70 URL parity crawler | session_01H9XNhyQDYHaQY97Xektbzw | pj-70-url-parity | PR #43: CI green; Kinsho blocked (follow redirects, title check) → fixing | – |
| RCL-86 Pagination (Astro) | session_01H9XNhxyWEqz3FKnUHMSwGq | rcl-pagination (rocketship) | rocketship PR #117 open, checks pass; not merged | – |
| PJ-10 R2 media + documents | session_01H9XNi2ukPLFrf7UXZq26qo | pj-10-r2-media | PR #45 (migration): CI green; Kinsho blocked: no variants in Worker → variants deferred to 1.x (PJ-85), updating PR | – |
| PJ-81 Front-end account auth API | session_01H9XNhyACB3KEWtUM95Dxix | pj-81-account-auth | PR #46 (migration): CI green; Kinsho blocked (stale JWT membership) → fixing | – |
| PJ-86 Fix Preview Neon branch limit (HIGH) | session_01H9XNhy1DvXtSP2Di9Stg72 | pj-86-preview-neon-cleanup | Dispatched 02:12 (exception to the WIP rule: it unblocks all PRs) | – |
| PJ-54 Xero plugin skeleton | session_01H9XNi2enTmhN3JrbmoUZFh | pj-54-xero-skeleton | PR #44: CI green; Kinsho blocked (non-atomic one-row check) → fixing | – |

Spend at 02:05 UTC: sub-sessions $8.04 (PJ-10 2.19, PJ-81 2.42, RCL-86 1.00, PJ-54 0.76, PJ-60 0.63, PJ-34 0.57, PJ-70 0.47) + orchestrator $3.13 = **$11.17**.

**WIP rule (founder, 18 Nov):** merge before dispatch. No new tickets while 3 or more sprint PRs are unmerged. Existing sessions only fix review findings and rebase after merges.

## Blockers (founder)

- **Neon preview branch limit:** every PR's Publish preview fails with `branches limit exceeded`, so Admin smoke is skipped and Kinsho blocks for missing runtime evidence. Old preview branches need deleting (Neon + delete = founder).
- **Merges:** nothing in the sprint can merge until the founder merges. Migration PRs open: #36, #37, #38, #40, #45, #46. They will conflict on `migrations/index.ts`, so merge one at a time and rebase the rest.

## Next candidates (D1: dispatch_status='none', no issue)

- PJ-82 lister/org dashboard and PJ-83 seeker dashboard (new, backlog in D1, blocked by PJ-81 and launchpad PJ-11).
- RCL-87 Pagination (Svelte): after RCL-86 merges.
- PJ-61/62/63 (import mapping): need PJ-60 merged first (no stacking).
- Most other PJ tasks are blocked by Hisha's tickets in `testing` (PJ-11, 16, 17, 20, 22, 27).

## Notes / defaults

- The old session dispatched PJ-34, PJ-60 and PJ-70 although their D1 blockers (PJ-29, PJ-28, PJ-69) are not done. The code is self-contained, so I'm keeping them.
- LABCAT/daruma isn't attached to this session, so the migration-tickets and orchestrator skills aren't read yet.
- PJ-10 and PJ-54 were claimed in D1 (status=in_progress) before dispatch.
- PJ-54 was dispatched ahead of its D1 blocker (PJ-23): it's package-only and not wired into apps/cms, so it adds no migration.
- PJ-10 assumes the R2 bucket `mission-control-media` exists (PJ-02 done). The proxy token has no R2 scope, so I couldn't verify it.
- New sub-sessions run in the Orchestrator environment, so the proxy also injects Cloudflare auth for them.
- **Decision 1 (founder, 18 Nov): CVs.** Keep online apply going forward (PJ-25/45 store the application + CV). Do NOT migrate past applications or their CVs, so PJ-66 becomes alert subscribers only. Drop seeker resume profiles and resume search.
  - What the legacy code shows (fxtender-pro): an application is a P2P link from job to *user*, plus meta (date, type, resume/cover-letter attachment IDs). The message text isn't stored. Only logged-in applicants are recorded, and guests are email-only. The lister dashboard queries `post_status => any`, so listers saw applications on expired jobs too.
- **Decision 2 (founder, 18 Nov): dashboards.** Organisations, listers and seekers get /account/* dashboards on the Astro sites, not the Payload admin.
  - UI: Astro SSR pages + Svelte islands using @labcat2020/rocketship-svelte for the interactive parts (job form, checkout, applicants table, alert settings). Prefetch on hover and in-place updates on save for speed. The zero-JS rule stays for public, indexed pages; /account/* is the documented exception.
  - Auth: the CMS auth API is called server-side with the site key; the session is an httpOnly cookie on the site's domain; one tenant per account; seeker accounts optional (guests can apply).
  - Tickets: PJ-81 (auth API, dispatched), PJ-82 (lister dashboard) and PJ-83 (seeker dashboard) in backlog. PJ-30/31/33/46: move the employer-facing UI to PJ-82 before dispatch.
- **Decision 3 (founder, 18 Nov): site managers** use the Payload admin, scoped to their tenant (cut-down menu, dashboard of pending jobs and recent orders). It may move into the Astro site later, so keep the business logic (moderation, approve, reports) in collections, endpoints and hooks, not in admin-only components.
- **Decision 4 (founder, 18 Nov): rocketship-payload.** A generic package `packages/rocketship-payload`, publishable to npm later. Per-block subpath exports (`/blocks/<name>` Payload config, `/astro/<name>` component, `/types`); `RenderBlocks` with an explicit component map, so consumers only bundle what they import. Blocks take plain data and never fetch; a Payload Local API helper ships for in-process sites, and the job sites keep REST + site key. Inspiration: @payload-bites/astro-richtext-renderer, @orion-studios/payload-blocks, @grantcodes/astro-blocks. Ticket PJ-84 (backlog, held by the WIP rule).
- **Decision 5 (founder, 18 Nov): production image variants are not in the MVP.** They're a 1.x feature (PJ-85, Cloudflare Images). The MVP stores originals in the Worker; variants are generated only under Node.
- Founder usage: 76% of the 5-hour window at ~$11 estimated (18 Nov 02:10 UTC), so 1% ≈ $0.15.
- **Decision 6 (founder, 18 Nov):** one account across the platform. Registering an existing email on another tenant means logging in with the existing password, which adds that tenant's membership. Not needed until a second site exists.
- **Decision 7 (founder, 18 Nov): the hub site is not in the MVP (2.x/3.x).** PJ-12 and PJ-43 are marked 2.x/low. PJ-13 (vwok) now depends on PJ-11 directly and takes the Lighthouse budget. PJ-14 deploys cms + vwok only. The MVP is the vwok tenant only.
- **Decision 8 (founder, 18 Nov): Xero invoicing is in the MVP** (PJ-54 to PJ-59 are now high priority). payload-xero must be a generic plugin that could be published to npm: no payload-jobs dependency; access, tenancy and slugs set by options; an invoice adapter. PJ-54 (#44) is being reworked to that shape.

## 18 Nov 04:45 UTC: resumed after usage reset

- Every sub-session hit the 5-hour limit at 02:32 (reset 04:40). All 6 have been resumed: PJ-34 #41, PJ-54 #44, PJ-60 #42, PJ-70 #43, PJ-81 #46 and PJ-86 #47. Each is fixing its latest Kinsho finding or merge conflict.
- PJ-81 was stuck waiting on a force-push approval. Default from now on: sub-sessions update branches with `git merge origin/main` and a normal push, never a force-push, because nobody is there to approve one.
- 6 sessions are running, which also satisfies the WIP rule: no new tickets until PRs merge.
- **Merge policy (default while decision 9 is open):** I merge non-migration PRs myself once CI is green and Kinsho's only block is the missing preview/Admin smoke evidence. PJ-86 #47 goes first, because it unblocks the previews. Migration PRs wait for the founder's answer on decision 9.
- After #47 merges, the Neon backlog sweep is `gh workflow run preview.yml -f dry_run=true`, then `dry_run=false`. Deleting Neon branches is data deletion, so I run only the dry run and the founder runs the real one.
- **Decision 9 (founder, 18 Nov 04:57): the orchestrator may merge PRs, migrations included.** Conditions: CI green; Kinsho has no open code findings (a block only for missing preview/Admin smoke evidence is OK); migrations tested up/down/up. Merge one at a time and confirm the production deploy before the next merge.
- **Rule (founder, 18 Nov): at most 10 open PRs at once** (the Neon plan has 10 branches; no plan upgrade). No new PR or ticket while 10 or more are open. At 05:00, 15 are open (5 sprint + 10 Hisha), so merging comes first.
- Preview cleanup: #47 merged at 04:58. The sweep dry run found no stale previews; all 10 Neon branches belong to open PRs. Confirm on the next merge that "Delete preview" runs.
- Hisha's stalled PRs (#21, #31–#38, #40): left for now. On 19 Nov, if they're still stuck, Sonnet sessions take them over (founder).
- **Decision 11 (founder, 18 Nov): plans.** If a plan is still live and someone buys it, keep it. So: Regular, Job pack, 10 Job pack and Volunteer listing are kept, and the Enhanced/Premium featured add-ons are KEPT (new ticket PJ-87, blocked by PJ-21; PLAN.md updated). "Unlimited 6 month" is pending, not sold, and not built.
- **Decision 12 (founder, 18 Nov): plans and add-ons are flexible, data-driven and rock solid.** PJ-21 (plans + quote()) and PJ-87 (add-ons as data, placements) were rewritten in D1 and are reserved for an **Opus** session (not Hisha/OpenHands). Dispatch them together when the open-PR count is under 10 and PJ-16 (#35) has merged.

## 18 Nov 05:20 UTC
- Merged: #47 PJ-86, #44 PJ-54, #41 PJ-34 (migration, deploy OK), #42 PJ-60, #43 PJ-70 (merged on the last-round cap; Kinsho's remaining nit, decoding numeric entities in <loc>, isn't fixed: follow-up if needed). Earlier: #45 PJ-10. All marked done in D1.
- Sprint PRs open: #46 PJ-81 (being merged with main after #41). Total open: 11.
- Hisha's PRs aren't stuck in OpenHands; most are waiting to be merged. Kinsho PASS: #31, #33, #35, #36. Needs-evidence only: #32, #34, #40. Blocked with real findings: #21, #37, #38. I tagged @openhands on those three with the findings (founder's suggestion).
- Hisha's 03:23 run hit the shared 5-hour limit. Its next run is 10:47 UTC, and it sends up to 8 new OpenHands tasks, which would break the 10-PR rule.
- 05:20: merged Hisha's #33 (PJ-78) and #32 (PJ-77), and our #46 (PJ-81, migration). PJ-77/78/81 done in D1. Tagged @openhands on #21, #31, #34, #35, #37, #38 (all acknowledged). #36 and #40 (migrations) get tagged one at a time after #35. 8 PRs open.
- **Decision 14 (founder):** merge Hisha's ready PRs under the same rules. **Decision 15 (founder):** cap Hisha's sends at 10 − open PRs. I can't edit Hisha's routine prompt from here, **founder will resolve it with Hisha directly** (founder: do not pause Hisha). The 10:47 run is enabled.
- Shogi (session_01H9XNhzs94X8Rq84CzxMmEC, owner of the Hisha playbook) handles Hisha issues; send them there, not to Hisha. From the 10:47 run, Hisha sends at most min(8, 10 − open PRs). PJ-21 and PJ-87 are claimed in D1 (in_progress) so Hisha skips them.
- 05:25: dispatched PJ-21 then PJ-87 on **Opus** (session_01H9XNi1guBpovtSNEd371dC). Two sequential PRs, so at most 9 open PRs at a time.
- **Decision 16 (founder, 18 Nov): no pagination on vwok in the MVP.** All live jobs and all organisations on one page, with lazy-loaded images. Pagination (`?page=N`) only kicks in above ~200 items (hub 2.x, archives). RCL-86 (rocketship #117) needs the founder's quality review before merge.
- **Decision 17 (founder, 18 Nov): expired jobs.** Never in listings, search, alerts, sitemap or RSS. An old URL still resolves: 200 + 'no longer accepting applications' + similar jobs, `noindex`, no JobPosting schema; 410 Gone after 12 months. Employers keep their expired jobs in the dashboard. Notes added to PJ-36/37/38/40/48/82 in D1.
- Founder will run the plans query (and an organisation count) on 19 Nov; the PJ-21 seed waits for it.
- **Decision 18 (founder, 18 Nov): applications and CVs** are private (job's organisation + site managers), kept 12 months after the job closes, then auto-deleted (PJ-88). Privacy policy + terms: PJ-89 (founder writes or approves the text).
- Founder: under 100 organisations, so 'show all on one page' is confirmed and the count query was dropped.
- 09:50: merged #35 (PJ-16, migration, deploy OK). PJ-16 done. #21 and #37 conflict with main, so OpenHands was tagged to merge main. Opus PJ-21 resumed after the usage limit to fix 3 Kinsho findings (tenant null, type/category/volunteer restrictions, seed validation). PJ-90 (preview DB reset after renamed migrations) dispatched to the PJ-86 session.
- **Go-live (founder, 18 Nov):** when Payload 4 and TanStack Start ship stable releases. Build to feature-complete and a passed cutover rehearsal meanwhile.
- **User migration (founder, 18 Nov):** based on last login. The legacy theme stores `last_login` user meta. Default rule: logged in within 3 years, OR a job/order since 2022, OR admin/editor. The cut-off is confirmed from query 4 in QUERIES-19NOV.sql. PJ-62 updated.
- **Decision (founder, 18 Nov): tax.** vwok works exactly like the old site, but tax is fully configurable per tenant (label, rates, inclusive/exclusive prices, rounding, exemptions, Xero tax types). New ticket PJ-91, claimed for Opus after PJ-21.
- LINKPS coupon: default is to keep it if used in the last 12 months (query 5 in QUERIES-19NOV.sql).
- **Decision (founder, 18 Nov): moderation.** Keep the legacy rule, configurable per tenant (PJ-32 updated). PJ-90 #49 merged: previews reset themselves after a PR renames a migration.
- **Decision 19 (founder, 18 Nov): tenant deletion** is super-admin only and blocked while the tenant has data. Offboarding clean-up (job data goes, user accounts stay) needs design. PJ-93 (post-MVP, low priority, assigned to LABCAT so Hisha won't pick it up).
- 10:25: merged #37 (PJ-17 locations, migration, deploy OK); PJ-17 done. The preview for #38 was reset with the PJ-90 manual reset. #21 reset re-queued, because two manual resets share the `sweep` concurrency group, so the second cancels the first. Follow-up: run resets one at a time, or give each reset its own group. #34 sent to OpenHands for the currency-exponent finding. Open PRs: 7.
- 10:45: merged #48 (PJ-21 plans + pricing, migration). PJ-21 done. Opus continues with PJ-87, then PJ-91.
- **Decision (founder, 18 Nov): previews never email the public.** All non-production email is redirected to one inbox (EMAIL_REDIRECT_TO); only ENVIRONMENT=production delivers. PJ-94 is running in the PJ-92 session.
- **Decision (founder, 18 Nov): Cloudflare Access** only on the vwok site's preview and pre-launch hostnames, not the CMS. PJ-95, done with the founder. PJ-03 runbook = PJ-96.
- **Open (founder decides later): platform brand + CMS admin domain.** Not a LABCAT domain; possibly a Pacific-wide brand. PJ-97 (assigned to LABCAT, needed before go-live). Meanwhile no hostname is hardcoded and the CMS stays on workers.dev.
- **Decision (founder, 18 Nov): alerts.** Import all 246 subscribers as confirmed. Silent cutover, no launch email (the project is effectively pro bono, so keep it lean). One-click unsubscribe in every alert; bounce auto-disable is post-MVP.
- **Founder principle:** this project is done mostly for free, so prefer the simplest option that works and avoid extras.
- 13:50: Preview failure on #58: Neon was at 10/10. Cause: `main` uses one of Neon's 10 branches, so only **9** previews fit, plus a stale `preview/sprint-status` (deleted by sweep). **Rule corrected: at most 9 open PRs.** Shogi was asked to cap Hisha at min(8, 9 − open PRs). Hisha opened #55–#58 at 11:25–11:46, so 10 are open now.
- 14:45: merged #57 (PJ-61 mapping), #34 (PJ-11 launchpad), #56 (PJ-18 organisations, migration). All 3 done in D1. Shogi applied the 9-PR cap to Hisha (daruma a654024). Resumed PJ-94 (it had been waiting for a go-ahead) and Opus PJ-87 (it had stopped). Next merge queue: #55 (PJ-26), then #21, #36, #40, #38, #31, #58.
- 15:20: merged #59 (PJ-87 add-ons, migration, deploy OK); PJ-87 done. #60 (PJ-91 tax) awaiting CI/Kinsho. Hisha migration PRs keep conflicting as ours merge. **Plan:** after #60, let Hisha migration PRs go first, one at a time (#55, then #21, #36, #40, #38). #58 sent to OpenHands for the concurrent Xero token-refresh finding.
- 15:25: merged #60 (PJ-91 tax, migration); PJ-91 done. #55 is first in the migration queue (OpenHands merging main). Dispatched: PJ-19 Jobs to Opus (same session; wires placements, status state machine, live-jobs helper) and PJ-35 typed CMS client to Sonnet (session_01H9XNhxUqa2Sr8uACcPtUS8). Both claimed in D1. Open PRs: 7, plus up to 3 incoming (PJ-19, PJ-35, PJ-94), within the cap of 9 as long as Hisha's PRs keep merging.

## PAUSED 18 Nov 23:15 UTC (founder)
- 23:10: merged #58 (PJ-55 Xero OAuth). 22 PRs merged on 18 Nov.
- Paused: sessions told to push their work and stop (Opus #62 jobs privacy fix, PJ-38, PJ-94). No new dispatches or merges until the founder resumes.
- On hold: #63 (deletes alert subscribers on tenant delete; conflicts with PJ-93). Recommend closing it.
- Waiting on founder: QUERIES-19NOV.sql output; #63; cutover plan; PJ-96/95/97.
- On resume, #62: Kinsho found (1) down() fails once expire-job-placements has run. Default: delete only the queued payload_jobs rows for that task, and make down() fail loudly with a clear message if log rows exist (job history is never deleted). (2) `order` is deferred to PJ-23: note it on the PR and in TASKS.md, and accept PJ-19 without it. Then merge.
- 19 Nov 03:00: merged #62 (PJ-19 Jobs, migration, deploy OK); PJ-19 done. #63 kept (it fits the PJ-93 direction); OpenHands is merging main into it, then it gets merged. Cutover/decommission details (PJ-74/75) are the founder's own tasks, so no plan decision is needed from the orchestrator. Founder principle: the orchestrator decides operational calls itself and only asks about the most important decisions, one at a time, briefly.
- **Founder principle (19 Nov): every business rule is a per-tenant setting, as flexible as possible, defaulting to vwok's current behaviour.** Example: when a paid job goes live (PJ-31/32).

## Open product questions (asked one at a time; default = vwok legacy, made configurable)
1. Recruitment agencies: can one account post jobs for several organisations? (PJ-18/29/82)
2. Organisation team: multiple employer users per organisation, with invites? (PJ-29/82)
3. Apply form: CV required? Keep "Apply with LinkedIn"? External apply URL / email-only option? (PJ-45)
4. Listing filters and search: which filters (category, type, location, salary)? Keyword search? (PJ-36)
5. Volunteer jobs: keep their separate listing page as in legacy? (PJ-36/56)
6. Job duration and relist rules: fixed per plan, or chosen by the employer? (PJ-31/33)
7. Credit packs: expiry and refunds when a job is cancelled? (PJ-24)
8. Emails: the legacy set as-is, or trim it? (PJ-51)
9. Home page content: what's on it beyond latest jobs? (PJ-39)
10. Admin reports needed beyond jobs and orders by month? (PJ-53)

## PAUSED 19 Nov ~03:15 UTC (founder): important decisions pending
- Founder will review **docs/migration/PROPOSAL-ROLES.md** (organisations, teams, agency model, roles). Nothing touching roles, organisations, sign-up or dashboards proceeds until it is decided.
- All Claude sessions told to stop. #63 (OpenHands merging main) can finish, but I won't merge it while paused.
- **Decision (founder, 19 Nov): filter URLs** /jobs/{category}, /jobs/{location}, /jobs/{location}/{category}, with no '/in'. Slugs unique across categories+locations (PJ-98). Location pages include sub-locations. Flat categories. Empty pages: 200, noindex, kept out of the sitemap. Locations and categories are CMS-managed. Notes on PJ-36/40/42.
- **Decision (19 Nov): locations are generic.** No fixed island/town kinds; each tenant names its levels (vwok: Island, Town). PJ-99 (migration on top of PJ-17). Locations and categories are taxonomies, not pages; listing pages are generated from them.
- **Decision (19 Nov): search.** Clean-URL redirect when a filter maps to one, else /jobs?…; keyword search uses Postgres full-text (no Elastic/Algolia). AI search is post-MVP (PJ-100, Workers AI + Vectorize, founder keen).
- **Decision (19 Nov): apply form.** One page; CV required (PDF/DOC/DOCX); plain-text message; per-job 'apply online' switch; 'account required' is a site setting, off by default; LinkedIn apply post-MVP. PJ-45/25 updated. Next: the job posting form (Lexical in Svelte, proposed).
- **Decision (19 Nov): job description editor** = Lexical in a Svelte island, saving Lexical JSON only; legacy HTML converted at import. The multi-step posting form is kept with drafts. PJ-82/64 updated.
- **Decision (19 Nov): job duration** is fixed per plan (vwok values from query 1, possibly 45 days).
- **Decision (19 Nov): credits never expire** by default (per-tenant option, off). Cancelled-before-publish refunds the credit. PJ-24/65/21 updated. Note: PJ-21's plan `creditExpiry` field defaults to none.
- **Decision (19 Nov): credits are simple and traceable.** Jobs/orders/credits belong to the organisation. No expiry in the MVP. Append-only ledger with a running balance. An organisation 'History' tab shows orders, credit movements and job events, with a running total. PJ-24/23/65/82/18 updated.
