# @mission-control/vwok

[vanuatuwok.vu](https://vanuatuwok.vu), the Vanuatu Wok job board: Astro on Cloudflare Workers as
`mc-vwok`. The theme and its components come from
[`@mission-control/launchpad`](../../packages/launchpad); this app supplies the branding and the
pages.

```bash
pnpm --filter @mission-control/vwok dev        # http://localhost:4321
pnpm --filter @mission-control/vwok build
pnpm --filter @mission-control/vwok typecheck  # astro check
pnpm --filter @mission-control/vwok lighthouse # build, then Lighthouse CI against astro preview
```

## Layout

| Path                   | What it is                                                    |
| ---------------------- | ------------------------------------------------------------- |
| `src/brand.ts`         | the tenant's branding, logo and the production hostnames       |
| `src/robots.ts`        | `robots.txt` for one hostname; production allows, previews block |
| `src/layouts/`         | page chrome around the launchpad `BaseLayout`                  |
| `src/pages/`           | routes                                                         |
| `public/brand/`        | logo and favicons, taken from the legacy WordPress uploads     |
| `lighthouserc.json`    | the performance budget                                         |

## Branding only

The green `#06914b`, red `#dd3333` and blue `#0066bf` in `src/brand.ts` are the legacy site's
palette. They reach the page only as Rocketship `--rs-*` tokens, written by the launchpad
`BaseLayout` onto `<html>`; nothing here restyles a Rocketship component.

Everything else a tenant decides — currency, minor units, timezone, locales, domains, the email
sender — comes from the `vwok` tenant document in the CMS. This app does not repeat any of it.

## Deploy

`wrangler.jsonc` names the Worker `mc-vwok`. `@astrojs/cloudflare` writes the server entry and the
assets directory into `dist/server/wrangler.json`, so `pnpm exec wrangler deploy` from this
directory deploys the build.

Local values go in `.dev.vars` (copy `.dev.vars.example`); nothing is read yet, and PJ-35 adds the
CMS URL and site key.

## Lighthouse budget

`lighthouserc.json` holds every category — performance, accessibility, best practices, SEO — at
≥ 0.98, plus at most 50 KB of JavaScript. The site ships none: there is no island, and the theme's
only island (`Turnstile`) appears on the forms PJ-45 and PJ-47 add.

The audit runs three times against `astro preview`, which serves the build through the Cloudflare
adapter, so it measures what the Worker serves. The CI job `Lighthouse (vwok)` runs the same thing
and uploads the HTML report.
