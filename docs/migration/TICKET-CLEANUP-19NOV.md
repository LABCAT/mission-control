# Ticket clean-up, 19 Nov 2026

Aligns the Payload Jobs (`PJ-*`) tickets on the Daruma D1 board with the founder's decisions of 18-19 Nov (`STATUS.md`, `PROPOSAL-ROLES.md`, `QUERY-RESULTS-19NOV.md`). Backup of every non-done row before the first write: `docs/migration/tickets-backup-19nov.json` (blockers there are task ids).

Rules kept: no status, dispatch_status, github_issue_number or assignee change on in_progress/testing/done tickets; no row deleted; done tickets untouched. Every non-done Agent ticket that is not already in progress/testing has a refreshed full `prompt` (goal, repo paths, quoted decisions, out of scope, prerequisites, migration rule, checks, branch/PR rules) and keeps its old notes below a 'history' marker in the description.

**Schema limitation:** the D1 `tasks.status` check does not allow `cancelled` (allowed: backlog, todo, in_progress, peer_review, testing, done). Retired tickets are therefore retitled `[CANCELLED] ...`, assigned to LABCAT and blocked by PJ-75, so the dispatcher skips them. Changing the check constraint is a schema change I did not make.

## Changed tickets

- PJ-03: Description: vwok email transport is YCV Google Workspace SMTP (OAuth2) per 19 Nov; Cloudflare Email Sending is the default for other tenants/fallback; Turnstile for vwok only (no hub)
- PJ-12: Held (2.x) with a full prompt; PJ-13 owns the Lighthouse CI budget; blocker PJ-74
- PJ-13: blocker nulled (PJ-11 done)
- PJ-14: Description cleaned: cms + vwok only, per-tenant settings, Cloudflare Access on vwok previews
- PJ-20: Home global dropped: home is a system page (PJ-103); pages are block-based; site-settings trimmed (no hero/promo/analytics ID); blocker nulled (PJ-15 done)
- PJ-22: blocker nulled (PJ-15 done)
- PJ-23: Rewritten: organisation-owned orders, payment-provider plug point, 'invoiced' status, generic external refs (no Xero fields in core), waiting-for-purchase approval, tax from quote()
- PJ-24: Rewritten: append-only credit ledger collection (no jobCredits int / ledger array on organisations), balance = sum, History data endpoint, no expiry
- PJ-25: Rewritten to the 19 Nov apply-form decision: CV required, plain-text message, consent, no legacyId (not imported), retention; blocker nulled (PJ-19 done)
- PJ-27: Rewritten to the final email decision (Lexical + chips inside payload-jobs, no Liquid); in-flight {{placeholder}} PR may land as interim; blocker nulled (PJ-09 done)
- PJ-28: CANCELLED: manual 'review and apply migrations to Neon main' is obsolete (decision 9: merges deploy and migrate; Neon prod reset at cutover PJ-73)
- PJ-29: Rewritten to the roles proposal + email-code verification (PJ-109); blocker PJ-109; PJ-28 dependency gone (cancelled); OPEN QUESTIONS on viewer role
- PJ-30: Re-scoped: Payload admin is for site managers (cut-down menu + dashboard of pending jobs and recent orders); employer UI is PJ-82; blocker nulled (PJ-19 done)
- PJ-31: Re-scoped to CMS endpoints (UI in PJ-82); blocker PJ-24 (PJ-30 no longer a prerequisite); close date max per plan; purchase permissions; payment-provider plug point
- PJ-32: Rewritten: per-tenant go-live and moderation settings; vwok default moderation off (query result); expiresAt = chosen close date capped by plan max; OPEN QUESTION on new-employer approval
- PJ-33: Re-scoped to endpoints; added cancel (credit refund before publish); relist = copy as draft -> checkout
- PJ-36: blocker nulled (PJ-35 done); description note that the prompt's pagination/URL lines are superseded
- PJ-37: OG/share image moved to PJ-105; expired-job rules, free-text salary, private-org rules, view counting kept; blocker nulled; OPEN QUESTION job URL vs filter slugs
- PJ-38: Directory is a payload-jobs block on the Organisations system page (no fixed page); org pages private by default; filters = type/size (area of focus dropped); duplicate rules; blocker nulled
- PJ-39: Home built from the home system page + blocks (not site-settings); menus rendered; blocker PJ-103
- PJ-40: Prompt refreshed; feeds = legacy two feeds, live jobs only, empty filter pages excluded, filter URLs in sitemap; llms.txt/GEO is PJ-104
- PJ-41: Prompt refreshed with the decided cache strategy (KV version, TTLs, hint cookie, junk-URL normalisation, tracking params)
- PJ-42: Prompt refreshed: redirect table = crawler output (PJ-70) + new clean URLs; legacy taxonomy/author/org URLs; table-driven test
- PJ-43: Held (2.x) with a full prompt; blocker PJ-74
- PJ-44: Hub removed: vwok only; blocker PJ-42 (PJ-43 is 2.x)
- PJ-45: Rewritten to 19 Nov apply decision: server-side recipient, per-job switch, site setting, signed file links, three emails; email path via sendTemplate; blocker PJ-50
- PJ-46: Re-scoped to endpoints; privacy rules; blocker PJ-45 (PJ-30 no longer needed)
- PJ-47: Rewritten to the Indeed-style alerts decision and moved into the alerts add-on package; blocker PJ-50
- PJ-48: Rewritten: send only when new matching jobs, max jobs per email (vwok 5), daily/weekly, run log + missed-run warning, never expired jobs; blocker PJ-47
- PJ-49: CANCELLED: superseded by PJ-102 (contact form block) + PJ-103 (contact system page)
- PJ-50: Rewritten to the final email decisions: Lexical + chips, one layout, sendTemplate single path, no bodies in log, masking after 90 days/delete after 12 months, monthly volume per tenant; converts PJ-27 storage
- PJ-51: Rewritten to the final event list (legacy set, one email per action); ownership split: application/alerts/expiry/sign-in/invite emails are emitted by their own tickets; blocker PJ-32
- PJ-52: Prompt refreshed: expiry task + 3-day warning + expired email, History events, cache bump, per-tenant lead time
- PJ-53: Rewritten: the two legacy reports in the reports add-on package (selectable fields; job views); blocker PJ-23 kept
- PJ-56: blocker nulled (PJ-55 done)
- PJ-57: Prompt rewritten: Xero is IN the MVP and high priority (the old 'deferred/low' text is gone); generic adapter shape; vwok account codes seeded; blocker PJ-23
- PJ-58: Prompt rewritten (Xero is MVP/high): endpoint + admin action for the invoice link; employer UI link is PJ-82
- PJ-59: Blocker nulled (PJ-55 done); description: vwok settings seeded from query 19
- PJ-62: Rewritten: user filter (last_login 3y OR job/order since 2022 OR alert OR admin), seekers kept, orgs per lister with billing/visibility/Xero fields, roles mapping; blocker nulled (PJ-60, PJ-34 done)
- PJ-63: Prompt written: originals only, referenced files only, no uploaded_cvs, R2 resumable; blocker PJ-62 (logos attach to organisations)
- PJ-64: Rewritten: Lexical conversion of legacy HTML, free-text salary, apply fields, featured placements, salary/type clean-up, view counts; no user_IP
- PJ-65: Rewritten: plans match query seed, coupons (LINKPS keep, others skipped), orders 24 months with pending->invoiced, Xero ids in externalRefs, credits as opening ledger rows; blocker PJ-64 kept; OPEN QUESTION expired coupons
- PJ-66: Retitled: no applications (decision 1); alerts become one daily email-only alert per legacy subscriber with the same filters; saved jobs from _starred_jobs; blocker PJ-83 (saved-jobs collection)
- PJ-67: Rewritten: pages -> system pages + blocks (home reproduced from legacy), menus, site settings (no analytics ID), page list from query results; blocker PJ-102
- PJ-68: Prompt written: expected counts and skipped totals per entity from the query results
- PJ-71: Rewritten flow to the new journey; blocker PJ-82 (journey needs the /account UI)
- PJ-73: Prompt refreshed + description: added legacy facts (SSH-tunnel import, port 3306, SPF/DMARC, DNS on Cloudflare, Access gate, monitoring)
- PJ-75: Description: also revoke the hardcoded MailChimp key; UpdraftPlus archive to Google Drive
- PJ-80: Prompt written: slug overrides everywhere (incl. add-ons), plug-point friendly options, remove job-tags + areas-of-focus, README rules (no migrations shipped); blocker nulled (PJ-19 done)
- PJ-82: Rewritten as an ORCHESTRATOR-SLICED umbrella: Astro /account for organisations (sign-in via PJ-109, org + team, jobs, form with Lexical, checkout, orders, History, applicants, stats); explicit slices; OPEN QUESTIONS (agency display, viewer role); blocker PJ-33
- PJ-83: Rewritten: seeker /account (applications, alerts, saved jobs [MVP, very important], profile basics, change password), saved-jobs collection + endpoints; blocker PJ-109
- PJ-84: Now MVP-critical (home blocks): priority high; first blocks = hero, feature boxes, rich text, card grid, CTA, FAQ; blocker none
- PJ-85: Held (1.x) with a full prompt; blocker PJ-74
- PJ-88: Prompt written; blocker PJ-25; adds admin action to delete an applicant's data
- PJ-89: Scope: policy pages + footer links + consent lines + admin 'delete user' action (account-deletion decision); blocker PJ-103
- PJ-93: Scope note: admin 'delete user' action is built in PJ-89
- PJ-96: Runbook steps: email transport is YCV Workspace SMTP for vwok (OAuth2), Cloudflare Email Sending optional; Turnstile for vwok only
- PJ-98: Prompt written; blocker PJ-99 (location migration first); job type slugs included
- PJ-99: Prompt written; blocker none
- PJ-102: Blocker PJ-103 (contact page role must exist); recreate vwok contact page with the two blocks
- PJ-103: Added: menus collection (import scope item 2); blocker PJ-84 (blocks needed for seeded content)
- PJ-104: Prompt written; blocker PJ-40 (robots/sitemap exist)
- PJ-105: Prompt written; blocker PJ-37
- PJ-107: Prompt written; blocker PJ-50; OPEN QUESTION: low value while vwok sends via Google SMTP
- PJ-109: Rewritten: sessions = 'Keep me signed in' (1 day / 30 days rolling) replaces 90 days; hint cookie; legacy hash upgrade; blocker PJ-50
- PJ-113: Held until screens exist; full prompt added; blocker PJ-71
- PJ-114: Held (post-MVP) with a full prompt; blocker PJ-74

Tickets I read and left unchanged because they already match the decisions (or are in flight and consistent): PJ-94, PJ-110, PJ-111, PJ-112, PJ-76, PJ-79, PJ-95, PJ-97, PJ-100, PJ-101 (parked idea), PJ-106, PJ-108, PJ-69, PJ-72, PJ-74. PJ-36's prompt is outdated (pagination, /jobs/category/:slug) but the ticket is in progress: its description now says the decisions win.

- Late decisions that arrived on `sprint/status` during the clean-up (org `approved` boolean, invoice parity / 'publish before payment') were appended as a 'LATE DECISIONS' block to the descriptions and prompts of PJ-23, PJ-31, PJ-32 and PJ-62.

## New ticket

- PJ-115: payload-jobs: core vs add-on packages + plug points (high, Agent, blocked by PJ-80). Defines core vs add-ons (alerts, reports, Xero) vs generic packages, the plug points (collections, email events, report types, account tabs, checkout steps, payment provider, job lifecycle hooks), the per-tenant add-on switch, and extracts the PJ-26 alerts code into `packages/payload-jobs-alerts`. sort_order `b1Zzq`.

## Retired tickets (see schema limitation)

- PJ-49 Contact form: superseded by PJ-102 (form + map blocks) and PJ-103 (contact is a seeded system page).
- PJ-28 Review and apply migrations to Neon main: obsolete (decision 9: merges deploy and migrate; production reset at cutover, PJ-73). PJ-29 no longer waits for it.
- Held, not cancelled (blocked behind PJ-74/PJ-71 on purpose, full prompts written): PJ-12, PJ-43 (hub, 2.x), PJ-85 (1.x), PJ-114 (post-MVP), PJ-113 (written from the finished screens).

## Dependency changes (blocked_by)

- PJ-12: PJ-11 -> PJ-74
- PJ-13: PJ-11 -> none
- PJ-20: PJ-15 -> none
- PJ-22: PJ-15 -> none
- PJ-25: PJ-19 -> none
- PJ-27: PJ-09 -> none
- PJ-28: PJ-27 -> PJ-75
- PJ-29: PJ-27 -> PJ-109
- PJ-30: PJ-19 -> none
- PJ-31: PJ-30 -> PJ-24
- PJ-36: PJ-35 -> none
- PJ-37: PJ-35 -> none
- PJ-38: PJ-35 -> none
- PJ-39: PJ-35 -> PJ-103
- PJ-43: PJ-36 -> PJ-74
- PJ-44: PJ-43 -> PJ-42
- PJ-49: PJ-50 -> PJ-75
- PJ-51: PJ-50 -> PJ-32
- PJ-56: PJ-55 -> none
- PJ-57: PJ-56 -> PJ-23
- PJ-59: PJ-55 -> none
- PJ-62: PJ-60 -> none
- PJ-63: PJ-60 -> PJ-62
- PJ-66: PJ-64 -> PJ-83
- PJ-67: PJ-63 -> PJ-102
- PJ-71: PJ-53 -> PJ-82
- PJ-80: PJ-19 -> none
- PJ-82: PJ-81 -> PJ-33
- PJ-83: PJ-81 -> PJ-109
- PJ-85: none -> PJ-74
- PJ-88: none -> PJ-25
- PJ-89: none -> PJ-103
- PJ-98: none -> PJ-99
- PJ-102: none -> PJ-103
- PJ-103: none -> PJ-84
- PJ-104: none -> PJ-40
- PJ-105: none -> PJ-37
- PJ-107: none -> PJ-50
- PJ-109: none -> PJ-50
- PJ-113: none -> PJ-71
- PJ-114: none -> PJ-74
- PJ-115: (new) <- PJ-80

No cycles (checked on the final board). Dependencies that can only be expressed once are written as the ticket expected to finish last; the other prerequisites are in each prompt ('stop and comment if not merged'). PJ-60 (done) still points at PJ-28; harmless, left untouched.

Agent tickets ready for the dispatcher now (backlog, no unmet blocker): PJ-25, PJ-30, PJ-37, PJ-62, PJ-80, PJ-84, PJ-99 (before: none). Next in line once these merge: PJ-98, PJ-103, PJ-63, PJ-88, PJ-115, PJ-40/41.

## OPEN QUESTIONS (need the founder)

- PJ-32: vwok default for NEW (unapproved) employers' jobs. The 19 Nov go-live note says 'new employer -> admin approval'; the query result says legacy moderation is off (`jr_jobs_require_moderation` empty). Seeded with moderation off until you decide.
- PJ-37 / PJ-42 / PJ-98: job detail URL. Filter URLs `/jobs/{category|location|type}` share the `/jobs/` namespace with legacy job pages `/jobs/{job-slug}/`. Default used: keep `/jobs/{job-slug}` and make job slugs avoid taxonomy slugs; alternative `/job/{slug}` with 301s.
- PJ-82: how an agency's job shows publicly (client name / 'confidential' / agency name). Default: client name when set, else the agency name.
- PJ-82 / PJ-29: is there a viewer-only member role? Default: no (owner + member).
- PJ-65: import expired legacy coupons (all except LINKPS) or skip? Default: skip unless used in the last 12 months.
- PJ-107: bounce tracking exists only on Cloudflare Email Sending, but vwok will send via YCV's Google SMTP. Still MVP? Default: keep, dispatch late.

Notes, not questions: alert subscriber counts differ across notes (246, 248, 560 users with a status); PJ-66/PJ-68 use 248 active. Several tickets (PJ-82, PJ-83, PJ-50, PJ-115, PJ-29) say to stop and ask for a split if the diff is too large: only one new ticket was allowed in this clean-up. Plan seed durations: vwok max duration is 45 days (PJ-32 tells the agent to check the PJ-21 seed).
