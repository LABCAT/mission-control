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
