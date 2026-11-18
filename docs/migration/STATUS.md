# Sprint status: Payload Jobs, week of 16 Nov 2026

Orchestrator: session_01H9XNhzozJtHHbbc8KMd38e (replaces session_01H9XNhytrTqfZdgCvKNP79m). Handover Mon 23 Nov.

## Running / in review

| Ticket | Session | Branch | State | Cost |
|---|---|---|---|---|
| PJ-34 WP password verifier | session_01H9XNhy2hU9XoAoarqxAoDP | pj-34-legacy-passwords | PR #41: told to fix typecheck (18 Nov) | $0.42 |
| PJ-60 WP import framework | session_01H9XNhzHksGv6x3guC2Y9cE | pj-60-wp-import-framework | PR #42, idle. 15 tests pass | $0.63 |
| PJ-70 URL parity crawler | session_01H9XNhyQDYHaQY97Xektbzw | pj-70-url-parity | Working (tests/lint) | – |
| RCL-86 Pagination (Astro) | session_01H9XNhxyWEqz3FKnUHMSwGq | rcl-pagination (rocketship) | Working | – |
| PJ-10 R2 media + documents | session_01H9XNi2ukPLFrf7UXZq26qo | pj-10-r2-media | Dispatched 18 Nov (migration PR) | – |
| PJ-81 Front-end account auth API | session_01H9XNhyACB3KEWtUM95Dxix | pj-81-account-auth | Dispatched 18 Nov | – |
| PJ-54 Xero plugin skeleton | session_01H9XNi2enTmhN3JrbmoUZFh | pj-54-xero-skeleton | Dispatched 18 Nov (package only, no migration) | – |

Sub-session spend so far: ~$1.05 (2 sessions not yet reporting).

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
