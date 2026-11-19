# @mission-control/launchpad

The Astro theme shared by every Mission Control job board site (`apps/hub`, `apps/vwok`, …).
It is a set of job-board compositions on top of [`@labcat2020/rocketship`](https://www.npmjs.com/package/@labcat2020/rocketship)
0.3.0, plus the small tenant helpers a page needs. It does no data fetching: the site app loads
the tenant and the jobs, then renders these components.

```bash
pnpm --filter @mission-control/launchpad build      # builds demo/ as a static site
pnpm --filter @mission-control/launchpad dev
pnpm --filter @mission-control/launchpad typecheck  # astro check over src/ and demo/
pnpm --filter @mission-control/launchpad test
```

CI then loads the built demo in Chromium (`.github/scripts/launchpad-smoke.mjs`, job
`Launchpad smoke`): the build proves the HTML exists, the smoke proves the page renders with
the tenant tokens in effect.

## Tenant tokens

`BaseLayout` takes a tenant document and writes its branding onto Rocketship tokens as a
`style` attribute on `<html>`. Custom properties inherit, so no tenant value ever becomes a
class name and no Rocketship component is restyled.

| Tenant branding | Rocketship token                                      |
| --------------- | ----------------------------------------------------- |
| `colorPrimary`  | `--rs-color-accent`, `--rs-color-link`                |
| `colorHover`    | `--rs-color-accent-hover`, `--rs-color-link-hover`    |
| `colorAccent`   | `--rs-color-focus-ring`                               |
| derived         | `--rs-color-accent-contrast`, readable on the primary |

Currency, timezone and locale always come from the tenant: `formatMoney` takes integer minor
units plus the tenant currency and exponent, `formatDate` takes the tenant timezone. When a
tenant omits `currencyMinorUnits`, the exponent comes from ICU
(`Intl.NumberFormat(…, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits`),
so VUV, VND, XOF and JPY divide by nothing and USD divides by 100.

A date-only value such as `2026-12-01` is a calendar day, not an instant: `formatDate` keeps it
on that day in every timezone, so a tenant west of UTC never shows a closing date as the day
before. Only timestamps (an ISO instant, a `Date` or an epoch) are converted to the tenant
timezone.

## Components

| Component    | Built from                          | Notes                                       |
| ------------ | ----------------------------------- | ------------------------------------------- |
| `BaseLayout` | Rocketship styles, `Container`       | head, SEO meta, canonical/header/footer slots |
| `JobCard`    | `Card`                               | salary and closing date in the tenant's settings |
| `OrgCard`    | `Card`                               | logo, description, open job count            |
| `FilterBar`  | `Field`, `Label`, `Input`, `Select`, `Checkbox` | plain GET form, works without JavaScript |
| `JobsListing` | `Alert`, `Grid`, `Typography`       | listing body: heading, filters, cards, empty state |
| `JobsPage`   | `BaseLayout`, `Container`            | whole `/jobs` page; filtered views are `noindex` |
| `Turnstile`  | `Field`                              | the only client island; site key from env    |
| `Pagination` | —                                    | **temporary**; moves to Rocketship (RCL task) |

`Pagination` is local on purpose: a pagination component is generic, so it belongs in
Rocketship. When Rocketship releases one, delete `src/components/Pagination.astro`, import the
Rocketship version, and keep `src/tenant/pagination.ts` (the page-number model) if it is still
useful.

## CMS client and edge cache (`@mission-control/launchpad/cms`)

Server-side only; import the subpath so none of it reaches a browser bundle.

```ts
import { cached, cacheTag, createCmsClient } from '@mission-control/launchpad/cms'

const cms = createCmsClient({ baseUrl: env.CMS_URL, siteKey: env.SITE_KEY }) // both from the site's env
const orgs = await cached(`org:${site}:all`, 300, () => cms.findAll('organisations'), {
  tags: [cacheTag('site', site), 'organisations'],
})
```

- Typed from `apps/cms/src/payload-types.ts` (type-only import). Sends `x-site-key`; throws `CmsError` (`http`, `network`, `timeout`, `invalid_response`) with no key in the message. `createCmsClient` throws if `window` exists.
- `findAll` is one request with `limit=0` (no pagination: listings show everything). Lists filter explicitly (e.g. live jobs: `where: { status: { equals: 'published' } }`); `findBySlug` adds no filter, so an expired job's page still resolves.
- `cached(key, ttl, fn, { tags })` uses `caches.default`; with no cache it just calls `fn`. `purgeTags(tags)` bumps each tag's version. The Cache API is per data centre, so a purge reaches only the colo that runs it: PJ-41 needs a shared store or the zone purge API (entries already carry a `Cache-Tag` header). Put the site in the key; nothing here knows the tenant.

## Job listing (`@mission-control/launchpad/jobs`)

`/jobs` and its sections are rendered from a `JobListingView`: plain data the page draws, so
nothing about the listing lives in a template.

```ts
import { jobListingRoute, serveJobListing } from '@mission-control/launchpad/jobs'

// One route file serves /jobs, /jobs/category/:slug and /jobs/type/:slug.
const route = jobListingRoute(Astro.url.pathname)
if (!route) return new Response('Not found', { status: 404 })

// Load, render, and hold the HTML at the edge for five minutes.
return serveJobListing({
  ...route, // { basePath, locked }
  cms,
  render: (view) => renderPage(view), // the site's `render` wrapper
  search: Astro.url.search,
  site: tenant.slug,
  tenant,
})
```

`jobListingRoute` is the only path-to-filter mapping; a site app does not repeat it. Both
`/jobs` and `apps/hub`'s cross-tenant listing (PJ-43) dispatch through it.

- Filters are `q`, `category`, `type`, `location` and `voluntary`. They live in the query string,
  the form is a plain GET, and the voluntary checkbox sends nothing when unticked: the listing
  works with no JavaScript, and a URL is a shareable set of results.
- Each value is validated against the tenant's own taxonomy slugs (`FilterDefinition`), so a
  hand-edited `?category=ceo` is dropped rather than sent to the CMS. A path slug the tenant does
  not have (`/jobs/category/nope`) is `found: false`, which the route turns into a 404.
- Twenty jobs a page. `?page=99` on a two-page listing serves the last page instead of an empty one.
- Sections fix a filter in the path (`/jobs/category/:slug`, `/jobs/type/:slug`); the slug is not
  repeated in the query string, and the filter form posts to `/jobs` so changing a control leaves
  the section instead of half-applying it.
- The query is live jobs only: published and either not expired or with no expiry
  (`liveJobsWhere` in `packages/payload-jobs`). Voluntary jobs are left out unless `voluntary=1`
  or the section is itself a voluntary type.
- `listingCache({ basePath, lockedKeys, search, site })` gives the edge-cache identity: the key
  (`<site>:html:<path>?<canonical filters>`), the tags (`site:<slug>`, `site:<slug>:jobs`) and
  the TTL (300s). `serveJobListing` builds it from the request *before* it loads anything, so a
  hit answers without a CMS query. Unknown parameters (`utm_*`), a meaningless `?page=1`, a filter
  the path already fixes and values that could not be a filter are dropped, so a stranger cannot
  fill the cache with junk; two filter sets never share an entry. PJ-41 purges the tags; a 404 is
  never cached.

## Conventions

- Zero client JavaScript by default. Only `Turnstile` ships a script, and only the forms that
  include it. The component owns its own `cf-turnstile-response` field, so the widget is
  rendered with `response-field: false`; otherwise the token would be posted twice. Its
  no-JavaScript notice is a `<noscript>`, so it is invisible when the script works.
- Money is an integer amount of minor units plus an ISO 4217 code, never a float.
- A tenant's domain, currency, timezone, locale and colours are never hardcoded here.
- Filter values come from the URL, so they are validated against `FilterDefinition` before
  they reach the page.
