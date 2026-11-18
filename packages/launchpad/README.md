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

## Components

| Component    | Built from                          | Notes                                       |
| ------------ | ----------------------------------- | ------------------------------------------- |
| `BaseLayout` | Rocketship styles, `Container`       | head, SEO meta, canonical/header/footer slots |
| `JobCard`    | `Card`                               | salary and closing date in the tenant's settings |
| `OrgCard`    | `Card`                               | logo, description, open job count            |
| `FilterBar`  | `Field`, `Label`, `Input`, `Select`  | plain GET form, works without JavaScript     |
| `Turnstile`  | `Field`                              | the only client island; site key from env    |
| `Pagination` | —                                    | **temporary**; moves to Rocketship (RCL task) |

`Pagination` is local on purpose: a pagination component is generic, so it belongs in
Rocketship. When Rocketship releases one, delete `src/components/Pagination.astro`, import the
Rocketship version, and keep `src/tenant/pagination.ts` (the page-number model) if it is still
useful.

## Conventions

- Zero client JavaScript by default. Only `Turnstile` ships a script, and only the forms that
  include it.
- Money is an integer amount of minor units plus an ISO 4217 code, never a float.
- A tenant's domain, currency, timezone, locale and colours are never hardcoded here.
- Filter values come from the URL, so they are validated against `FilterDefinition` before
  they reach the page.
