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
| `src/env.ts`           | the Worker's environment (`CMS_URL`, `SITE_KEY`, the AI switch) |
| `src/robots.ts`        | `robots.txt` for one hostname; production allows, previews block |
| `src/sitemap.ts`       | `/sitemap.xml` and its shards, read from the CMS               |
| `src/og-route.ts`      | an `/og/…` path → the page it names, and that page's card     |
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

## Crawling

`/sitemap.xml` lists the home page, the listing, live jobs, public organisations and published
pages, plus the category and type pages that have at least one live job. An expired job, an empty
filter page and a `noindex` page are never listed, and a query-string filter page has no URL here
at all. The rules live in `@mission-control/launchpad/seo`; this app only supplies the CMS client
and the origin.

Both routes need two Worker variables (see `.dev.vars.example`):

| Variable   | What it is                                                  |
| ---------- | ----------------------------------------------------------- |
| `CMS_URL`  | the CMS origin, e.g. `https://mc-cms.labcat.workers.dev`     |
| `SITE_KEY` | the vwok tenant's site key; a secret, never sent to a page   |

Without them `/sitemap.xml` answers 404 rather than an empty sitemap, because an empty one tells a
crawler the site has no pages.

`robots.txt` blocks `/admin`, `/account` and `/api`, points at the canonical sitemap, and blocks
the whole site on a preview host. AI crawlers are allowed by default — vwok's legacy behaviour —
and `AI_CRAWLERS_ALLOWED=false` turns them away until the per-tenant setting (PJ-104) lands.

## Deploy

`wrangler.jsonc` names the Worker `mc-vwok`. `@astrojs/cloudflare` writes the server entry and the
assets directory into `dist/server/wrangler.json`, so `pnpm exec wrangler deploy` from this
directory deploys the build.

Local values go in `.dev.vars` (copy `.dev.vars.example`): `CMS_URL` and `SITE_KEY` are the CMS
secrets (PJ-35).

## Lighthouse budget

`lighthouserc.json` holds every category — performance, accessibility, best practices, SEO — at a
perfect **1.0**, as a phone (Lighthouse's default mobile emulation), plus at most 50 KB of
JavaScript. It audits the home page and a job page (`/jobs/head-chef`). The site ships no script
beyond the job page's small view beacon.

The pages need content, and CI has no CMS, so `scripts/lighthouse-server.mjs` starts
`scripts/lighthouse-cms.mjs` (a fixed-content stand-in for the REST API) next to `astro preview`
and points the Worker at it through `dist/server/.dev.vars`. The audit therefore measures what the
Worker serves for a real CMS page and a real job, not the static shell. Nothing from the fixture
ships.

`/jobs` is not mounted in this app yet. Until it is, `lighthouserc.listing.json` audits the same
`JobsPage` components through the launchpad demo (`pnpm --filter @mission-control/vwok
lighthouse:listing`), with the same thresholds. When the route lands, add its URL to
`lighthouserc.json` and drop the second config.

What the pass changed, and why the score holds:

- **Critical CSS**: `build.inlineStylesheets: 'always'` puts the page's CSS in the HTML, so no
  stylesheet blocks the first paint. Pages are cached at the edge, so the bytes are paid once.
- **Header logo**: drawn at most 200 px wide with the file's own aspect ratio, so a phone gets a
  sharp image (the file needs about 2x the pixels the box fills) and the box is reserved before it
  loads (no layout shift). Upload a logo at least 400 px wide for a 200 px display.
- **Favicons on every page**: the job page and the listing take a `head` slot, so the brand icons
  load from the page instead of the browser asking for `/favicon.ico` and getting a 404.
- **Heading order**: job cards directly under the listing's `h1` are `h2`s.
- **Fonts**: the theme uses the system font stack, so there is no web font to subset or preload.
  If a tenant adds one, self-host a subset `woff2` and preload it.
- **Images**: content images carry their size and load lazily below the fold; the hero image is
  eager with `fetchpriority="high"`. Originals only (variants are PJ-85).
