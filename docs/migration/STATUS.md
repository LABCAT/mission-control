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
- **Decision (19 Nov): member purchase rights.** 'Use credits' on, 'buy/invoice' off by default (owner decides). Otherwise 'Waiting for purchase' plus a one-click owner approval. Future card payments: any member can pay by card unless the owner disables it.
- **Decision (19 Nov): emails** are sent only by the CMS via one sendTemplate path; one layout per tenant; trimmed event list to show the founder. Email log keeps no bodies, masks the recipient after 90 days, deletes after 12 months. PJ-50/51 updated.
- **Decision (19 Nov): email templates** = our own generic Payload plugin with Liquid (liquidjs) and one tested layout. TOP PRIORITY, to be published to npm (founder to pick the scope + provide a token). PJ-101 dispatched. The community plugins (GrapesJS/easy-email/newsletter) were rejected: Payload v3, heavy, built for marketing email.
- **Decision (19 Nov): npm naming.** One scope, @labcat2020: payload-jobs, payload-xero, payload-email-cloudflare, payload-email-liquid-templates (PJ-101). Rename the internal @mission-control/* packages at publish time. Publishing needs the founder's npm token.
- **Decision (19 Nov): package boundaries.** payload-jobs uses the Liquid templates plugin as an optional peer dependency (declares events + schemas, built-in fallback templates). The same rule applies to other cross-package links.
- **Decision (19 Nov, final): email templates** live inside payload-jobs, edited with Lexical plus variable chips; per-tenant logo/colours/footer; one tested layout. No Liquid, no separate npm plugin (PJ-101 cancelled → PJ-50).
- **Decision (19 Nov): home page** is block-based (rocketship-payload generic blocks + payload-jobs job blocks). The initial content reproduces the legacy page: hero+search, 3 feature boxes, latest jobs (featured first), rich text. PJ-39/67/84/20 updated. PJ-84 is now needed for the MVP.
- **Decision (19 Nov): reports.** Carry both legacy custom reports across: jobs+orders by month CSV with selectable fields (PJ-53) and job views CSV. Nothing else for the MVP.
- **Decision (19 Nov): modular payload-jobs.** Core (orgs, jobs, plans, credits/orders, coupons, applications, emails) exposes plug points. Add-ons are **separate workspace packages from day one** (Xero, reports, ...), each switchable per tenant. Selling add-ons is post-MVP; no licensing work now.
- **Decision (19 Nov): job alerts = add-on package.** Mission Control (job boards as a service) installs and enables all add-ons; the package split only matters for selling payload-jobs separately later.
- **Decision (19 Nov): listing filters** = legacy set, each switchable per tenant: keyword, location, category, job type, salary band, date posted. Clean URLs only for category, location and job type; other filters are query params; no type+category/location path combos.
- **Decision (19 Nov): job type pages** /jobs/{type} for every type (menu-linkable). Per-type setting 'listed separately' (hidden from main listings/search); vwok = on for Volunteer (legacy). Type slugs join the PJ-98 uniqueness rule. Import brings whatever type terms exist.
- **Decision (19 Nov): email list (PJ-51)** = legacy set: new user welcome/verify, reset password; job submitted (admin+employer), edited job pending, approved/live, expiring in 3 days, expired; order created (admin+owner), order paid, order cancelled; application to employer + copy to applicant + copy to site admin (per-tenant toggle, vwok on as legacy); contact form; alerts digest (add-on). New with orgs: invite, waiting-for-purchase approval, duplicate/join request, org page approved. Dropped: pack expired, resume subscriptions.
- **Decision (19 Nov): one email per action.** Posting a job that creates an order sends ONE email to the employer ("Job submitted", including the order/invoice details). A standalone order email only for orders with no job (credit packs). Same rule for admin. Contact form: kept only if legacy has a live tpl-contact page (query 7); otherwise a normal CMS page with contact details.
- **Decision (19 Nov): contact page.** Legacy /contact has a form + Google map → two generic blocks in rocketship-payload: Form (official Payload form builder plugin; Astro renderer reused if one exists, else built in rocketship-payload) and Map (no-key embed). PJ-102, after PJ-84.
- **Decision (19 Nov): form renderer** is plain Astro in rocketship-payload (Rocketship inputs). Queue job deletes form submissions past a per-tenant retention setting (default 90 days; 0 = email only, not stored). PJ-102.
- **Decision (19 Nov): admin copy of applications** = per-tenant setting (vwok on, as legacy). Applications + CV files already deleted after the per-tenant retention (PJ-88, default 12 months); email log keeps no bodies/attachments.
- **Decision (19 Nov): organisation pages approval** = per-tenant setting, vwok on (legacy: lister requests, admin approves). Listed regardless of live jobs. Owner can make it private again themselves.
- **Decision (19 Nov): pages, not globals.** Home/About/Contact/Organisations are system pages (role field): seeded per site, undeletable (unpublish only). Home at /, no parent/children; Organisations no children (directory block + other blocks). PJ-103.
- **Decision (19 Nov): GEO.** One SEO tab; structured data generated automatically; llms.txt; per-tenant AI-crawler setting. PJ-104.
- **Decision (19 Nov): share images.** Auto-generated per job/org/home, with org logo (fallback site logo), PNG 1200x630, R2 + edge cache. PJ-105.
- **Decision (19 Nov): payments.** No PayPal. vwok MVP = invoice only, invoiced by Youth Challenge Vanuatu (as today, via Xero add-on). Core gets a generic payment-provider plug point; Stripe is a post-MVP add-on. Collecting on tenants' behalf with Wise payouts = post-MVP idea, needs accountant first (PJ-106).
- **Decision (19 Nov): job alerts** Indeed-style: saved search = alert, no account needed (double opt-in, per-tenant setting), several per email, daily/weekly, only when new jobs, direct links, per-alert unsubscribe. Alert run log + missed-run warning; per-email detail via email log filter. PJ-47/48.
- **Decision (19 Nov): deliverability.** Cloudflare email delivery events -> Queue -> email log status; hard bounces/complaints suppressed and alerts paused. PJ-107. Legacy alerts ARE migrated (each legacy subscriber -> one daily email-only alert with the same filters, also for users not migrated by last_login).

## Import scope (19 Nov, from code review of the legacy repo; confirm with queries 8–16)
Already planned (PJ-61..67): taxonomies + locations, active users + orgs + password hashes, media/logos/PDFs to R2, jobs (published + expired), plans/coupons/orders (24 months) + credits, alert subscribers, pages + site settings.
Add / confirm:
1. **Blog posts:** founder believes there are none; blog templates exist but look like leftovers. Not imported unless query 9 shows published posts.
2. **Menus** (top, primary, footer) → CMS menus (query 11).
3. **Extra taxonomies:** job_tag, job_salary (salary band filter), area-of-focus (org directory filter) (query 10).
4. **Organisation fields:** org type, org size, cover image (profile_picture), logo, listing status (enable_organisations_page / listing_request) (queries 12, 15).
5. **Invoice-me flag** per customer (can_pay_by_bank_transfer + billing email) → organisation billing settings (query 15).
6. **Job view counts** (wp_jr_counter_total) → feed the job views report (query 14).
7. **Xero invoice IDs** on orders (planned) – contacts are matched by name/email in the add-on.
8. **Redirects:** every legacy URL (jobs, orgs/authors, taxonomies, pages, blog) → new URL (PJ-70 parity crawler).
Not imported: applications/CVs, resumes, logs (order-log, job-alerts-log, resume-reminder-log), comments (unless query 16 shows real use), PayPal data.
**MailChimp: dropped.** The code only runs if the registration form sends an `update_subscription` field, and no vwok form has it (a Do Good Jobs leftover). The hardcoded MailChimp key in the legacy repo should still be revoked.
- **Decision (19 Nov): seeker accounts kept and migrated** (same last_login cut-off as other users). MVP account: my applications, my alerts, profile basics.
- **Decision (19 Nov): no seeker profiles in MVP; no saved jobs in MVP.** Future idea only: PJ-108 (private apply profile, or a professional page on a pacificjobs.com hub).
- **Decision (19 Nov): English only.** No locales/translations in the MVP (as legacy; editors may write other languages in page content). Only cheap prep: UI strings in one place per site, html lang from a site setting.
- **Decision (19 Nov): sign-in** = email (link + code in one email) + optional password (legacy WP passwords keep working via PJ-34, upgraded on first login); 90-day sessions; Google/Microsoft post-MVP; no Facebook. PJ-109.
- **Decision (19 Nov): analytics.** Default Cloudflare Web Analytics (tiny, no cookies); fallback server-side counting (Workers Analytics Engine). GA/Pixel etc only via Cloudflare Zaraz, set up by us on request (site-settings IDs post-MVP). No GTM in MVP (later: per-tenant GTM ID loaded on first interaction). Whether vwok needs GA at all: wait for query 18.

## Query results 19 Nov (docs/migration/QUERY-RESULTS-19NOV.md) – findings
- **Plans (seed):** Basic 3,900 VT; Enhanced 5,900 VT (featured 30 days); 5 Job Pack 17,500 VT (5 credits); 10 Job Pack 33,000 VT (10 credits); Volunteer free. Relist price = price. Pack credits never expire (matches decision). No 'Premium' published (1 pending plan from 2019).
- **Duration:** plans say 30 days, but site default is 45 and jobs have a per-job close date (fxtender `_jr_fx_expire_days`): the employer picks a close date, max 45 days. → FOUNDER CHECK.
- **Expired jobs:** legacy setting `jr_expired_action = hide` (contradicts the earlier reading). Our decision (200 + banner + noindex, 410 after 12 months) stands as a per-tenant setting; FOUNDER CHECK.
- **Moderation:** off in legacy (`jr_jobs_require_moderation` empty, edits need no approval) → vwok default off.
- **Admin copy of applications:** on (`jr_bcc_apply_emails = 1`) – matches decision.
- **Alerts:** daily, max 5 jobs per email, 560 users with alert status. Default 'max jobs per alert email' = 5 for vwok.
- **Users:** 15,844 total; last_login known for 3,418 (2023+: 1,630). Many spam accounts (disposable domains). Migration rule (last 3 years or has job/order/alert, admins) stands.
- **Coupons:** LINKPS (1,900 VT off, no end date) used 501 times, 77 coupon orders in the last 12 months → keep. Others expired → import as expired or skip.
- **Orders:** 5,902 transactions stay 'pending' (bank transfer never marked complete in WP; payment lives in Xero). Import maps them to 'invoiced', not 'unpaid'.
- **Xero:** 71 users have `xero_contact_code` → import onto organisations for the Xero add-on.
- **Saved jobs exist:** `_starred_jobs` on 240 users → FOUNDER CHECK (we said legacy had none).
- **Blog:** none (1 draft). Not imported. Comments: none.
- **Pages to import:** About us, Contact (contact-2), For Employers, Organisations, Volunteering, Land Law Reforms, Organisation Competition; the rest are WP/JobRoller system pages (dropped). No privacy page; T&C from 2017.
- **Taxonomies:** job_type (13), job_cat (29), job_salary (18) used; job_tag and area-of-focus unused → dropped.
- **Job fields to import:** company/URL, how to apply, per-job application email (`jr_fx_apps_recipient_address`), apply-online switch, address + geo, displayed salary text, featured flags, view counts (9.29M total). Not imported: `user_IP`.
- **Analytics:** only a dead Universal Analytics tag (UA stopped in 2023) → **no GA for vwok**; Cloudflare Web Analytics only.
- **Email providers:** gmail 6,249; yahoo 540; hotmail+outlook 446 → Google login is the useful one post-MVP; Microsoft low value.
- **Tax:** not in the first 100 rows of query 6 → follow-up query needed.
- **Decision (19 Nov): job duration** = employer picks a close date, max per plan (vwok: 45 days); default close date = max. Overrides the 'fixed per plan' note.
- **Decision (19 Nov): analytics visible in the product.** Admin dashboard widget (Cloudflare Web Analytics via API + our own numbers); employers see views/applications per job in /account. PJ-110.
- **Decision (19 Nov): analytics packaging.** Traffic panel = generic plugin @labcat2020/payload-cloudflare-analytics (any Payload site); job stats stay in payload-jobs core. PJ-110.
- **Tax (query 19):** legacy charges no tax on the site (tax_charge = 0); prices as listed. Xero: account codes 225 (job plan), 226 (add-on), 227 (coupon discount), invoices due in 14 days, no payment reconciliation, no tracking category. → vwok tax setting = none; Xero add-on settings seeded with these codes.
- **Decision (19 Nov, confirmed): expired jobs** stay as decided (200 + banner + noindex, 410 after 12 months), per-tenant setting; vwok uses it despite legacy 'hide'.
- **Decision (19 Nov, founder: very important): saved jobs in the MVP** + import legacy _starred_jobs (240 users). PJ-83/PJ-66.
- **Decision (19 Nov): viewed jobs** via localStorage ('Viewed' label + recently viewed), no score impact. PJ-111.
- **Decision (19 Nov): pricing.** 'Plans' block in payload-jobs core (data from plan records; Astro renderer exported by payload-jobs), placed on normal pages such as For Employers. Same rule for all job blocks (latest jobs, organisation directory, job search): payload-jobs; generic blocks: rocketship-payload.
- **Decision (19 Nov): account deletion.** No self-service in MVP (legacy has none; Delete Me plugin not active). Privacy policy: email us. Admin 'delete user' action removes personal data, keeps orders/invoices (anonymised link). Add to PJ-89/PJ-93 scope.
- **Decision (19 Nov): no launch email, no sign-in notice** (YCV may announce if they want).
- **Email costs (19 Nov research):** Cloudflare Email Sending (Workers Paid): 3,000/month included, then US$0.35 per 1,000. Resend: free 3,000/month but max 100/day; Pro US$20/month for 50,000, US$0.90 per 1,000 over. vwok estimate ~10–15k/month → Cloudflare ≈ US$3.50–4.20/month extra vs Resend US$20. Stay on Cloudflare; daily alerts are fine. Track monthly volume per tenant in the email log for billing.
- **Decision (19 Nov): email transport per tenant.** Cloudflare Email Sending (default; bounce tracking) or the tenant's own SMTP (via Worker TCP sockets, no server). vwok: YCV's Google Workspace SMTP (as legacy Post SMTP), if MX confirms Workspace; switch to Cloudflare if limits/deliverability bite. Bounce tracking (PJ-107) only on Cloudflare. Update PJ-92/PJ-50.
- **Confirmed (19 Nov): ycv.vu is on Google Workspace** (MX = aspmx.l.google.com). vwok sends via YCV Workspace SMTP (~2,000/day limit). Needs: a sending mailbox + app password/OAuth from YCV (secret, set by founder), SPF/DKIM already Google's.
- **From Hisha's orchestrator session (checked 19 Nov):** open founder items: Kinsho secrets/app on daruma (DD-139); Orbit ORBIT_READ_TOKEN; delete orbit tag admin-hang-diagnostics. PJ-10 R2 bucket: main deploys with the MEDIA binding (mission-control-media) succeed, so the bucket exists (couldn't list R2 with our token). Hisha sends 0 because every PJ backlog task is blocked by a dependency → fix in the ticket clean-up.
- **Results 20–27 (19 Nov):** uploads 4.6 GB (fits R2 free 10 GB). Post SMTP = Gmail SMTP, **OAuth2** (not app password), smtp.gmail.com:587 TLS, ycv.vu sender → PJ-112 must support XOAUTH2 (refresh-token) as well as password. 248 active alert subscribers. Migration rule keeps 1,817 of 15,844 users. Menus: Main = Jobs, Volunteering, For Employers, Organisations, About us; Top = Contact us; Bottom = YCV link, Password Reset, Submit Job, Login. Salary bands and job types need clean-up at import (broken '000'/'1'/'2' terms, Independant/Independent, Internship/Board position under a missing parent 84). WP-Cron runs on page visits (no system cron); UpdraftPlus daily backups. Results 28–34 pending.
- **Results 28–34 (19 Nov):** DB = MySQL 8.0.37 on a separate server; **port 3306 is open to the internet** (user locked to the web server IP) → SECURITY: founder should firewall 3306 to the web server only. Import plan: read via SSH tunnel through the web server (no DB changes; mysqldump available there). No server-level redirects (Apache front controller + HTTPS only). Access logs unreadable without sudo (top URLs unknown → rely on PJ-70 sitemap crawler). Roles: 11,282 job_lister, 4,349 job_seeker, 207 job_lister+upload, 4 admins. Orders ≈ 55/month (1,333 in 24 months; 1,312 'pending' = invoiced). Uploads: 70k files; company_logos 3.0 GB; 1,104 job PDFs (406 MB); uploaded_cvs = personal data, NOT imported. DNS for vanuatuwok.vu is on Cloudflare (cutover easy); no SPF/DMARC on vanuatuwok.vu; ycv.vu SPF lacks include:_spf.google.com (deliverability risk for Gmail-sent mail; YCV should add it).
- **Decision (19 Nov): Facebook auto-posting** not in legacy (no code/plugin; jr_facebook_id empty) → post-MVP idea. Share images (PJ-105) make manual sharing look good.
- **Decision (19 Nov): listing order** = legacy: a 'Featured' block above the list (newest first), then all jobs newest first. Only 'featured listing' (home, /jobs, search) for vwok, for its paid duration (30 days). 'Featured in category' NOT seeded for vwok (used on 62 jobs ever vs 513 featured; no current plan includes it); the generic add-on placement stays available for other tenants. Per-tenant setting: featured sort newest|random (vwok newest).
- **Decision (19 Nov): taxonomy names.** Category (collection job-categories, label per tenant, vwok 'Category'), Location, Job type, Salary. Area of focus and job tags dropped (no terms in DB) – collections removed. All payload-jobs collection slugs overridable in plugin options to avoid clashes (locations/organisations/jobs). PJ-80.
