# Payload Jobs – sprint status (18–23 Nov 2026)

Orchestrator: cloud session, archived Mon 23 Nov after handover. Tickets: `docs/migration/tickets/`.

## Running (Sonnet sub-sessions, one PR each)

| Ticket | Repo | Branch | Session | PR | State |
|---|---|---|---|---|---|
| PJ-34 WP password verifier (scoped) | mission-control | pj-34-legacy-passwords | session_01H9XNhy2hU9XoAoarqxAoDP | – | running |
| PJ-60 WP import framework | mission-control | pj-60-wp-import-framework | session_01H9XNhzHksGv6x3guC2Y9cE | – | running |
| PJ-70 URL parity crawler | mission-control | pj-70-url-parity | session_01H9XNhyQDYHaQY97Xektbzw | – | running |
| RCL Pagination | rocketship | rcl-pagination | session_01H9XNhxyWEqz3FKnUHMSwGq | – | running |

## Hisha / OpenHands (hands off)
Dispatched issues: #20 #22 #23 #24 #25 #26 #28 #29 #30 #39. Open PRs: #21 #31–#38.
Merge queue is the bottleneck: #31 #35 #36 #37 #38 all edit `payload-jobs/src/index.ts`, `tenancy.ts`, `payload-types.ts`.

## Open decisions (founder)
1. CVs – used? in MVP? (PLAN.md drops resumes; blocks PJ-25/PJ-45 apply form scope)
2. Astro dashboards for job seekers / listers (PLAN.md: no seeker accounts, employer = Payload admin)
3. Where admins manage their site
4. rocketship-payload content site: scope + repo

## Defaults assumed
- Can't read/claim dashboard tasks: no AGENT_API_TOKEN here, and task GET/PATCH aren't on the agent allowlist. Picked only tasks with no GitHub issue and no visible Hisha work; PJ-34/60/70 are `backlog` (blocked_by) on the board so not in Hisha's queue.
- PJ-34 scoped to verifier + hook helper (no Users wiring until PJ-29).
- PJ-70 built now as a tool; run at cutover.
- Sub-session PRs avoid `payload-jobs/src/index.ts`, `tenancy.ts`, `apps/cms` to stay clear of Hisha's PRs.

## Findings
- `apps/cms/.env.example` (from orbit) holds values: localhost docker DB URL + a dev placeholder `PAYLOAD_SECRET`. Not a live secret; should be blanked upstream in orbit.

## Usage (sub-session cost_usd)
| Date | Sum | Founder meter |
|---|---|---|
| 18 Nov | 0 | – |
