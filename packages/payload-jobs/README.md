# @mission-control/payload-jobs

Job-board collections and tenant settings for [Payload](https://payloadcms.com). Built for the
Mission Control job board and usable on its own: it adds no dependency on the CMS app that
started it.

Tested with Payload `4.0.0-beta.7`.

## What it adds

| Collection | Default slug | |
|---|---|---|
| Locations | `locations` | Region → island → town tree. |
| Organisations | `organisations` | Employer profiles, approval and billing fields. |
| Job categories | `job-categories` | |
| Job types | `job-types` | Includes the volunteer flag. |
| Salary bands | `salary-bands` | |
| Plans | `plans` | Sellable listing plans. |
| Add-ons | `add-ons` | Featured listings and other extras. |
| Alert subscriptions | `alert-subscriptions` | Email job alerts. |
| Jobs | `jobs` | Listings, statuses, placements. |
| Coupons | `coupons` | Discount codes. |
| Orders | `orders` | An organisation's orders: fixed money, status, append-only history. |

In single-tenant mode it also adds the `job-board-settings` global. In multi-tenant mode the
tenant fields (currency, timezone, locales, tax, sender, moderation) are appended to the host's
tenants collection instead.

Every collection belongs to a tenant in multi-tenant mode. The plugin leaves `site-keys` and the
tenants collection to the host application.

## Install

```bash
pnpm add @mission-control/payload-jobs
```

Register the plugin **before** `@payloadcms/plugin-multi-tenant`, so the multi-tenant plugin sees
the collections the job board added.

### Single site

```ts
import { payloadJobs } from '@mission-control/payload-jobs'

export default buildConfig({
  // ...
  plugins: [
    payloadJobs({
      tenancy: 'single',
      // Optional: use the host's upload collections.
      mediaSlug: 'media',
      documentsSlug: 'documents',
    }),
  ],
})
```

### Multi-tenant

```ts
import { jobsTenantCollections, payloadJobs } from '@mission-control/payload-jobs'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'

export default buildConfig({
  // ...
  plugins: [
    payloadJobs({ tenancy: 'multi', tenantsSlug: 'tenants' }),
    multiTenantPlugin({
      // One line: every tenant-scoped collection, under the resolved slugs.
      collections: Object.fromEntries(jobsTenantCollections().map((slug) => [slug, {}])),
      tenantsSlug: 'tenants',
    }),
  ],
})
```

If you rename slugs (below), pass the same options to both:

```ts
const collections = { locations: { slug: 'job-locations' } }

payloadJobs({ tenancy: 'multi', collections })
multiTenantPlugin({
  collections: Object.fromEntries(jobsTenantCollections({ collections }).map((slug) => [slug, {}])),
})
```

`payloadJobsTenantCollections(slugs)` returns the same list when you already have resolved slugs.

## Slug overrides

Every collection slug can be renamed. Generic names such as `locations`, `organisations` and
`jobs` clash on other sites, so nothing internal uses a literal: relationships, hooks, queries,
the placement task and the seeds all use the resolved slug.

```ts
payloadJobs({
  collections: {
    locations: { slug: 'job-locations' },
    organisations: { slug: 'employers' },
    jobs: { slug: 'vacancies' },
    jobCategories: { slug: 'categories' },
    jobTypes: { slug: 'employment-types' },
    salaryBands: { slug: 'salaries' },
    plans: { slug: 'packages' },
    addOns: { slug: 'extras' },
    alertSubscriptions: { slug: 'subscribers' },
    coupons: { slug: 'vouchers' },
    orders: { slug: 'purchases' },
  },
})
```

Keeping the defaults in the table above needs no migration. Choosing a slug before your first schema migration needs nothing extra, but renaming one on an installation that already has the tables changes the schema: generate and apply your own app migration for it.
`jobsSlug` still works for older configs; `collections.jobs.slug` takes the same slot.

## Orders and payment providers

An order belongs to an organisation. It keeps a frozen copy of what was sold (the
`snapshotQuote()` value, the add-ons and the tax lines) and its money in whole minor units; none
of that changes after create. The status moves only along `ORDER_TRANSITIONS` (`paid` and
`cancelled` are final), and every change lands in the append-only `log`. Members read their
organisation's orders, tenant admins change them, and nobody deletes one, or a tenant,
organisation or job an order points at.

Core registers the `invoice` provider. A payment add-on registers its own, and an order may only
name a registered one. An owner (by default a user whose `organisationRole` is `owner`) can answer
a member's purchase request (`waiting_for_purchase` → `pending` or `cancelled`); pass
`isOrganisationOwner` to decide ownership another way:

```ts
payloadJobs({
  orders: {
    isOrganisationOwner: ({ organisationID, user }) => isOwner(user, organisationID),
    paymentProviders: [{ key: 'stripe', label: 'Card' }],
  },
})
```

System code acting for a signed-in user under `overrideAccess` sets
`req.context[ORDER_SYSTEM_CONTEXT] = true`; a request with no user is system code already.

## Access overrides

Each collection also accepts an `access` object. It is merged over that collection's defaults,
operation by operation, so overriding `read` leaves `create`, `update` and `delete` unchanged.

```ts
payloadJobs({
  collections: {
    jobs: {
      access: {
        read: ({ req }) => Boolean(req.user),
      },
    },
  },
})
```

The defaults are the job-board rules: public reads expose only published/published-equivalent
content (organisations only when approved and page-enabled; plans and add-ons only when on sale;
jobs only when published, plus expired ones for site keys), while writes need the relevant tenant
role. Anonymous site reads go through the host's `site-keys` collection. Organisations and jobs
also accept a site key with its own publication filter.

## Migrations

**This package ships no migrations.** The generated tables depend on the host's config (its
tenants collection, upload collections, localization), so the app owns them:

```bash
pnpm payload migrate:create payload_jobs
pnpm payload migrate
```

Run that once after adding the plugin to an existing app. Commit the generated migration with the
app. Schema changes in later releases are listed in the release notes together with the data
helpers needed to transform existing rows (for example `seedVanuatuLocations`, `seedPlans`,
`seedAddOns` and the `*SeedProblems` validators). Never edit a migration already applied by an
installation.

### Upgrading from a build with the extra taxonomies

`job-tags` and `areas-of-focus` were removed: the legacy database has no terms for either. An
existing installation should let its app generate the migration that drops those tables and the
`organisations.areasOfFocus` column, then run it as usual.

## Docs and tests

```bash
pnpm vitest run packages/payload-jobs
```

Released as part of a monorepo under the `@mission-control/` scope; the package name may change
before a standalone npm release.
