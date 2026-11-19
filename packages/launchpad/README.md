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
| `FilterBar`  | `Field`, `Label`, `Input`, `Select`  | plain GET form, works without JavaScript     |
| `Turnstile`  | `Field`                              | form island; site key from env               |
| `RecentlyViewed` | —                               | browser-local list, filled on idle           |
| `JobViewTracker` | —                              | records the current job on a detail page     |
| `Pagination` | —                                    | **temporary**; moves to Rocketship (RCL task) |

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
- `cached(key, ttl, fn, { tags })` uses `caches.default`; with no cache it just calls `fn`. `purgeTags(tags)` bumps each tag's version. The Cache API is per data centre, so a purge reaches only the colo that runs it: PJ-41 needs a shared store or the zone purge API (entries already carry a `Cache-Tag` header). Put the site in the key; nothing here knows the tenant.

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
