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
| `JobCard`    | `Card`                               | salary and closing date in the tenant's settings; reveals a "Viewed" pill |
| `OrgCard`    | `Card`                               | logo, description, open job count            |
| `FilterBar`  | `Field`, `Label`, `Input`, `Select`, `Checkbox` | plain GET form, works without JavaScript |
| `JobsListing` | `Alert`, `Grid`, `Typography`       | listing body: heading, filters, cards, empty state |
| `JobsPage`   | `BaseLayout`, `Container`            | whole `/jobs` page; filtered views are `noindex` |
| `Turnstile`  | `Field`                              | the only client island; site key from env    |
| `RecentlyViewed` | —                               | browser-local list, filled on idle           |
| `JobViewTracker` | —                              | records the current job on a detail page     |
| `Pagination` | —                                    | **temporary**; moves to Rocketship (RCL task) |
| `PageView`   | `RenderBlocks`, `BaseLayout`         | a whole CMS page: blocks in editor order, menus in the chrome |
| `SiteNav`    | —                                    | one menu in a landmark; marks the current page |
| `LatestJobs` | `Grid`, `JobCardBody`                | the latest-jobs block: featured first, empty state, listing link |
| `JobCardBody` | `Card`                              | the job card without its script, for pages that ship none |

## CMS pages (`@mission-control/launchpad/pages`)

A site renders its pages from CMS data, never from a route per page. One load per request:

```ts
import { loadSite, pageView } from '@mission-control/launchpad/pages'

const content = await loadSite({ cms, pathname: Astro.url.pathname, tenant })
if (content.kind !== 'page') return notFound(content.menus) // menus still draw the chrome

const view = pageView(content, { tenant })
```

- `loadSite` reads the site's pages and menus once and resolves the path against the page tree
  (`resolveContentRoute`): `/` is the page with role `home`, `/<parent>/<slug>` is the chain of
  slugs, and anything else is `not-found`. It loads the latest jobs only when the page's layout
  names that block.
- `pageView` turns the loaded page into plain data for `PageView.astro`: the layout split into
  runs of generic blocks and the data-needing block in between (`pageSegments`), the page
  metadata, and the menus (`menuViews`). Blocks render through an explicit component map the site
  passes in, so a page bundles only the renderers it names.
- A menu item that names a page follows that page's current path; a custom URL keeps its
  new-tab flag and is refused if its scheme is unsafe.
- Collection slugs come from the plugin options (PJ-80): pass `collections` (pages, menus, jobs)
  and, when the host registered it under another name, `latestJobsSlug`. The defaults match a
  stock installation.

## Viewed jobs (browser-local)

`src/viewed-jobs` stores the last 20 viewed job ids in `localStorage` under `lp:viewed-jobs`,
newest first. There is no server store and no account sync; every storage access is guarded, so
private modes and cleared storage simply show no history. `record(jobId)`, `list(limit)` and
`has(jobId)` are the whole API.

Use `JobViewTracker` on a job detail page (pass the same id `JobCard` uses in `data-job-id`:
the job's id, or its url). `JobCard` reserves the "Viewed" pill's space and reveals it on idle,
so the label never shifts the layout. `RecentlyViewed` renders an empty hidden section and fills
it on idle from `list(5)`. Give it one of:

- `jobs`: `{ id, title, url }[]` already on the page (used as-is), or
- `endpoint`: a URL that accepts `?ids=a,b,c` and returns the same array as JSON.

The site app owns the endpoint; the component only documents the contract. Place the list where
it can grow without moving content above it (for example, the last block on the page).

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
- `cached(key, ttl, fn, { tags })` uses `caches.default`; with no cache it just calls `fn`. `purgeTags(tags)` bumps each tag's version. The Cache API is per data centre, so a purge reaches only the colo that runs it: global invalidation is the content version below, not `purgeTags`. Put the site in the key; nothing here knows the tenant.

## Content versions and the public page cache (PJ-41)

Global invalidation without a purge. Each tenant has a **content version** in Cloudflare KV
(`CONTENT_CACHE`, key `content-version:<tenant slug>`). It is part of every edge cache key, so a
CMS write that bumps it makes every data centre miss at once. The CMS (`payload-jobs`
`contentVersions` option) bumps it on any change to jobs, organisations, pages, menus, taxonomies,
locations, plans, add-ons and the site settings, and on `all` for aggregate sites; the hourly
expiry job (PJ-52) must call `bumpContentVersions` when jobs expire or featured ends. KV errors
never fail a save or a page. The CMS and every site must bind the **same** namespace: copy the id
from `apps/cms/wrangler.jsonc` into each site's wrangler config after the first deploy.

- `servePublicPage({ normalise, render, site, store })` (`tenant/page-cache`) redirects a
  non-canonical URL (301, before any lookup), reads the version once and stores the page under
  `<site>:html:<version>:<canonical url>`. `apps/vwok` applies it in `src/middleware.ts` to every
  page except `/account`, `/api`, `/health`, assets and files.
- Normalisation (`tenant/cache-key`): unknown parameters dropped, values validated, parameters
  sorted, `?page=1` dropped. **Tracking parameters** (`utm_*`, `gclid`, `gbraid`, `wbraid`,
  `fbclid`, `msclkid`, `ttclid`, `li_fat_id`, `ref`; add more with `tracking.extra`) are ignored
  for the key but kept in the URL and never 301-stripped, so client-side analytics still sees them.
- Lifetimes (`cms/headers`): HTML 7 days at the edge, browser `max-age=60` (never `s-maxage`, so a
  CDN rule cannot outlive the version), hashed assets one year `immutable`, media one year;
  `/health`, `/account` and forms `no-store`. A response that sets a cookie is never stored.
  Without a KV binding pages fall back to a 5 minute edge TTL.
- `/health` (`tenant/health`): 200 or 503, `no-store`; a site checks its Worker and the CMS, whose
  `/health` checks the database. Point UptimeRobot at each site's and the CMS's `/health`.

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
- Every CMS read passes the tenant's locale (`resolveLocale`), because the job title and the
  taxonomy names are localized fields: without it a site gets Payload's default language.
- `readListingQuery(search)` is the one reading of a request: it returns the filters and the page
  number, and both the cache key and the CMS query come from it. That is what stops them
  disagreeing — if the key dropped a filter the query kept, a filtered response would be stored
  under a bare URL's key and served to everyone for five minutes. It cuts a keyword to 100
  characters and clamps the page to 500 rather than dropping either, since a dropped value would
  change what the URL means.
- `listingCache({ basePath, lockedKeys, search, site })` gives the edge-cache identity: the key
  (`<site>:html:<path>?<canonical filters>`), the tags (`site:<slug>`, `site:<slug>:jobs`) and
  the TTL (300s). `serveJobListing` builds it from the request *before* it loads anything, so a
  hit answers without a CMS query. Unknown parameters (`utm_*`), a meaningless `?page=1`, a filter
  the path already fixes and values that could not be a filter are dropped, so a stranger cannot
  fill the cache with junk; two filter sets never share an entry. PJ-41 purges the tags; a 404 is
  never cached.
- A page that is not the one its URL names is not stored. A filter the tenant has no value for
  (`?category=made-up`) and a page past the end both still render a correct page, but not *that*
  URL's page: storing each made-up slug would waste an entry per slug. The view carries
  `inexact` for this, and `serveJobListing` answers those with `Cache-Control: no-store`.

## Sitemap and robots (`@mission-control/launchpad/seo`)

`./seo` is the pure rules, `./seo/serve` adds the CMS read and the edge cache, `./seo/robots` is
`robots.txt` as data. A site app supplies the CMS client, the tenant and the origin:

```ts
import { serveSitemap } from '@mission-control/launchpad/seo/serve'

return serveSitemap({
  cms: createCmsClient({ baseUrl: env.CMS_URL, siteKey: env.SITE_KEY }),
  path: Astro.url.pathname, // /sitemap.xml or /sitemap-1.xml
  site: tenant.slug,
  siteUrl: Astro.site!.origin,
  tenant,
})
```

- Live jobs only: the loader asks the CMS with `liveJobsWhere(now)`, so an expired job cannot
  reach the builder. A page is listed unless it is a draft or `seo.noIndex`; an organisation must
  be approved with its page enabled.
- A filter page is listed only while it has a job, so the sitemap never advertises an empty page
  that answers `noindex`. Query-string filters have no URL in it at all.
- `filterPaths` says where a site's filter pages live. It defaults to `/jobs/category/:slug` and
  `/jobs/type/:slug` (the routes `jobListingRoute` serves); `cleanFilterPaths` is the founder's
  one-level scheme for when PJ-42 adds those routes. A kind with no builder is not listed, so the
  sitemap never names a URL the site cannot answer.
- One file up to 45,000 URLs, then `/sitemap.xml` becomes an index over `/sitemap-1.xml` … and a
  shard the current plan does not have is a 404.
- XML and robots answers are held at the edge for an hour under `site:<slug>` and
  `site:<slug>:sitemap`, which PJ-41's purge clears.

## Conventions

- Zero client JavaScript by default. Only `Turnstile` ships a script, and only the forms that
  include it, plus the tiny browser-local viewed-jobs scripts on pages that use `JobCard`,
  `JobViewTracker` or `RecentlyViewed`. The component owns its own `cf-turnstile-response`
  field, so the widget is rendered with `response-field: false`; otherwise the token would be
  posted twice. Its no-JavaScript notice is a `<noscript>`, so it is invisible when the script
  works.
- Money is an integer amount of minor units plus an ISO 4217 code, never a float.
- A tenant's domain, currency, timezone, locale and colours are never hardcoded here.
- Filter values come from the URL, so they are validated against `FilterDefinition` before
  they reach the page.
