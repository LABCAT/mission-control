# Proposal: organisations, teams and roles (19 Nov, awaiting founder review)

Status: **PROPOSED, NOT DECIDED.** Work is paused so the founder can review this.

## Founder's direction (19 Nov)
- An organisation should be a real organisation with one admin, who can add other users to post jobs on its behalf (the current WordPress set-up is messy).
- Recruitment agencies: one account can post for several organisations (the founder agreed in principle; refined below).
- Everything configurable per site, defaulting to vwok's current behaviour.

## How other job boards do it (Seek, Indeed, LinkedIn)
- **The company account is the unit.** One owner/admin manages billing and invites colleagues. Team members post and manage jobs and see applicants.
- **Agencies are their own company account**, flagged as an agency. They post on behalf of clients; the job shows the client's name (or "confidential") with "posted by Agency X".

## Proposed roles

| Level | Role | Can do |
|---|---|---|
| Platform | Super-admin (founder) | Everything |
| Site | Site manager | Run the site: approve jobs, plans, reports |
| Site | Editor | Pages and content only |
| Organisation | Owner | Billing, profile, invite/remove members |
| Organisation | Member | Post and manage jobs, see applicants |
| Organisation | Agency flag | Post on behalf of named client companies |
| Public | Seeker (optional account) | Apply, alerts, application history |

The agency model replaces "one account in several organisations". All of it is configurable per site.

## Open points for the review
- Is there a viewer-only member role (sees applicants, can't post)?
- Agency jobs: show the client name, "confidential", or the agency name by default?
- Who pays for agency jobs: the agency (default) or the client?
- How are the legacy `job_lister` / `recruiter` users mapped (PJ-62)?

Affects tickets: PJ-18 (organisations, merged), PJ-29 (sign-up), PJ-62 (import), PJ-81 (account roles, merged), PJ-82 (dashboard).

## Founder notes (19 Nov) and revised answer
1. **Site editor:** legacy `editor` only managed users (not content). For the MVP: drop the separate content Editor role. Site manager covers it. The role can be added later per site.
2. **Agencies:** an agency IS its own organisation (type = agency). A client organisation can post jobs itself AND have agencies post other jobs for it.
   - Agency jobs belong to the agency organisation (the agency pays and manages them) and optionally name a client: a link to an existing organisation, or free text, or "confidential".
   - The client organisation's page can list jobs posted for it by agencies (configurable).
   - No user needs to be in several organisations.
   - Legacy `recruiter` users → members of an agency organisation.

## Proposed sign-up flow (19 Nov, asked to founder)
- "Post a job" sign-up creates the user + organisation together. One question: employer or recruitment agency (default employer; a site manager can change it). First user = **owner**.
- Other users join by **owner invite only** (email invite → set password → member).
- Duplicate organisation name → "this organisation exists, ask the owner for an invite" (or a site manager links them). No duplicate organisations.
- Seekers: separate, optional sign-up.
- Configurable per site.

## Decided 19 Nov (founder)
- **Never block a paying sign-up.** A name match still creates the organisation, flagged as a possible duplicate. The existing owner gets a one-click "X wants to join" approve email; on approve, the user and their jobs move in. Otherwise a site manager merges the organisations (jobs, members, orders) or clears the flag. Needs a small "merge organisations" admin tool.
- **Organisation pages are private by default.** The owner chooses to make the page public. A possible-duplicate organisation can't be made public until the duplicate is resolved. Jobs still show the organisation name. Imported vwok organisations keep their current visibility. All configurable per site.
- **Organisation pages list only that organisation's own jobs.** A possible duplicate's jobs never appear on the official organisation's page until merged in. They still appear in normal job listings under their own name.
