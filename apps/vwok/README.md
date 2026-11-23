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
| `src/page-route.ts`    | one request path → the CMS page it names, a 404, or the shell   |
| `src/pages/`           | the catch-all route, plus `robots.txt`                         |
| `public/brand/`        | logo and favicons, taken from the legacy WordPress uploads     |
| `lighthouserc.json`    | the performance budget                                         |

## Branding only

The green `#06914b`, red `#dd3333` and blue `#0066bf` in `src/brand.ts` are the legacy site's
palette. They reach the page only as Rocketship `--rs-*` tokens, written by the launchpad
`BaseLayout` onto `<html>`; nothing here restyles a Rocketship component.

Everything else a tenant decides — currency, minor units, timezone, locales, domains, the email
sender — comes from the `vwok` tenant document in the CMS. This app does not repeat any of it.

## Pages

Every public page is a CMS page (PJ-39): `src/pages/[...path].astro` resolves the request path
against the site's pages, so `/`, `/about` and `/about/team` need no route files. The launchpad
`PageView` draws the page's blocks in the editor's order, with the site's menus in the header and
footer. An unknown path answers 404.

The block renderers are named explicitly in the route, so a page bundles only what it can draw.
With no `CMS_URL`/`SITE_KEY` the site serves a static home shell and every other path is a 404;
that is what the Lighthouse run measures.

## Deploy

`wrangler.jsonc` names the Worker `mc-vwok`. `@astrojs/cloudflare` writes the server entry and the
assets directory into `dist/server/wrangler.json`, so `pnpm exec wrangler deploy` from this
directory deploys the build.

Local values go in `.dev.vars` (copy `.dev.vars.example`): `CMS_URL` and `SITE_KEY` are the CMS
secrets (PJ-35).

## Lighthouse budget

`lighthouserc.json` holds every category — performance, accessibility, best practices, SEO — at
≥ 0.98, plus at most 50 KB of JavaScript. The site ships none: there is no island, and the theme's
only island (`Turnstile`) appears on the forms PJ-45 and PJ-47 add.

The audit runs three times against `astro preview`, which serves the build through the Cloudflare
adapter, so it measures what the Worker serves. The CI job `Lighthouse (vwok)` runs the same thing
and uploads the HTML report.
