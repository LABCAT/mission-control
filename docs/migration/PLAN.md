# Mission Control – plan

Mission Control is a multi-tenant job board platform. Vanuatu Wok (vanuatuwok.vu) is the first customer site, moving off WordPress/PHP. It runs alongside a LABCAT-owned aggregate site (the "hub"), and more sites are sold later, in any country.

Inputs:
- `AUDIT.md`: what the old site does.
- `USAGE.md`: what's actually used. Anything unused is not built.
- `TASKS.md`: the small tasks for the Daruma board (project **Payload Jobs**, prefix `PJ`).

## Repos

| Repo | Role |
|---|---|
| `LABCAT/orbit` | Upstream. A generic Payload 4 + TanStack Start CMS on Workers (Neon via Hyperdrive, release workflow that migrates and deploys). Generic fixes go here first. |
| `LABCAT/mission-control` | **The repo we work in.** Created from orbit's history, with `upstream` = orbit (see `docs/UPSTREAM.md`). A weekly PR syncs from upstream (PJ-05). All job-board code lives in `packages/` and in new `apps/`, so merges from orbit stay clean. |
| `LABCAT/rocketship` | The design system, `@labcat2020/rocketship` on npm. From 0.3.0 it has 24 Astro components: layout, cards, typography, all the form controls, Table, Dialog, Popover, Tooltip, Disclosure. Generic components we need are added here first (see principle 4). |
| `LABCAT/vanuatuwok.vu` | The legacy WordPress site. Read-only reference and the source of the import. Its `migration-plan` branch has the original audit; **`mission-control/docs/migration` is now the source of truth.** |

## Layout of `mission-control`

```
apps/cms          multi-tenant Payload (admin + API + cron), one Worker for all tenants
apps/hub          Astro Worker – aggregate site, shows jobs from every tenant
apps/vwok         Astro Worker – vanuatuwok.vu, the Vanuatu Wok tenant only
packages/payload-jobs       jobs, organisations, taxonomies, locations, plans, orders, applications, alerts, emails
packages/payload-xero       per-tenant Xero invoicing
packages/payload-wp-import  WordPress/JobRoller importer
packages/launchpad           Astro theme + data client on Rocketship, shared by every site app
```

Each new site sold = a new tenant row + a small `apps/<site>` (branding, domain, pages). There's no new back end per site.

## Principles

1. **Build only what's used** (`USAGE.md`). Features that are dropped stay dropped until a customer asks for them.
2. **Nothing tenant-specific is hardcoded.** Each tenant has its own currency, timezone, locales, location list, tax label, email sender, domain, branding and Xero connection. Money is stored as integer minor units plus a currency code.

   Tenant settings store `locales[]` and `defaultLocale`, so one tenant can serve multiple locales later. Vanuatu Wok is English-only for now; adding another locale must not require a schema change.
3. **Public sites aim for a PageSpeed score of 100.**
   - Astro, with mostly static/edge-cached HTML and no client JavaScript by default. Forms are the only interactive islands.
   - Images go through R2 with resized variants.
   - Lighthouse CI is used as the performance budget check.
4. **Rocketship first.** Before building a UI component, check Rocketship's repo and Storybook.
   - A **generic** piece (pagination, tabs, badge, empty state, a form widget) goes into `LABCAT/rocketship` as a Rocketship Component Library task, gets released, and launchpad then uses it.
   - Only **job-board** compositions (JobCard, OrgCard, FilterBar, apply form) live in `launchpad`, built from Rocketship parts and its `--rs-*` tokens.
   - Launchpad never forks or restyles Rocketship. Tenant branding only sets `--rs-*` variables.
5. **The Payload admin is the employer app, for v1.**
   - Employers sign up on the site, then post, pay (invoice), edit and end jobs in the Payload admin, which is scoped to their tenant and organisation.
   - Nicer front-end forms are a later choice, not a blocker.
6. **Specs live in the tasks.** Every task has its own done check. Where it makes sense, behaviour is checked against the old site.
7. **Cutover is reversible.** The droplet is kept as a snapshot until 30 days after go-live.

## Decisions vs the old site

**Organisations:** these become a real collection, instead of being a set of fields on a user. Employer users belong to an organisation.

**Job seekers no longer need an account:**
- Applying is a form on the site.
- Job alerts are an email-only subscription with a double opt-in and a manage/unsubscribe link.
- Existing alert subscribers are imported as already confirmed.

**Dropped:**
- online payment gateways
- resumes and resume access
- blog
- the separate volunteer flow ("Voluntary" is just a job type)
- MailChimp

**Kept:**
- featured add-ons (Enhanced, Premium): still sold, so kept (founder, 18 Nov; PJ-87)
- invoice checkout with plans, packs (as credits) and coupons
- Xero invoicing
- PDF job descriptions
- online apply
- daily alerts
- organisation pages
- CMS pages
- the editable emails that are still used
- CSV reports

**Users:** only active users are migrated. Their WordPress passwords keep working, and are rehashed on first login.

## Phases

| Phase | What | Tasks |
|---|---|---|
| 0 | Setup: repo (done), Neon/Hyperdrive/R2, email domain, Turnstile | PJ-01–03 |
| 1 | Monorepo foundation: multi-tenancy, cron, email, R2, launchpad, empty hub and vwok apps, deployed | PJ-04–14 |
| 2 | `payload-jobs` data model | PJ-15–28 |
| 3 | Employer experience in the admin: sign-up, checkout, moderation, job actions | PJ-29–34 |
| 4 | Astro sites: listings, job pages, organisations, pages, SEO, cache invalidation, redirects, performance | PJ-35–44 |
| 5 | Applications, alerts, contact, emails, scheduled jobs, reports | PJ-45–53 |
| 6 | `payload-xero`, **much later**. Invoices are done by hand in Xero until then. | PJ-54–59 |
| 7 | `payload-wp-import` | PJ-60–69 |
| 8 | Verify, cut over, decommission | PJ-70–75 |

## Rough estimate

AI-assisted hours (my review, integration and testing):

| Scope | Hours |
|---|---|
| Phase 0–1 | 12–20 |
| Phase 2–5 | 50–80 |
| Phase 6 (Xero) | 12–20 |
| Phase 7–8 (import, cutover) | 15–25 |
| **Total for hub + vwok** | **≈ 90–145** |

About 15–25 of those hours are the platform/multi-tenant part. That's an investment in the product, not part of Vanuatu Wok's cost. Each extra site after this should mostly be setup and branding.

## Open questions

These are deferred and don't block the build:

- Front-end posting and editing for employers (vs the Payload admin).
- Online card payments for other tenants (Stripe?).
- Pricing and ownership terms for Vanuatu Wok as a tenant: who owns the data, and how they'd leave.
- A data-region policy, if a tenant needs its data kept in a particular country.
