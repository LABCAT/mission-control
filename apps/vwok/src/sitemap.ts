/**
 * The site's sitemap routes: `/sitemap.xml` and its shards.
 *
 * Which URL goes in the sitemap is decided in `@mission-control/launchpad/seo`; this file only
 * supplies the CMS client, the tenant and the canonical origin. Filter pages default to the
 * routes the theme serves today (`/jobs/category/:slug`, `/jobs/type/:slug`); PJ-42 adds the
 * clean `/jobs/{location}/{category}` routes, and this app then passes `cleanFilterPaths`.
 */
import { createCmsClient, type CacheLike } from '@mission-control/launchpad/cms'
import { serveSitemap, type SitemapCms } from '@mission-control/launchpad/seo/serve'

import { siteTenant } from './brand'
import { siteEnv, type SiteEnv } from './env'

export type SiteSitemapOptions = {
  /** Edge cache; defaults to `caches.default`. */
  cache?: CacheLike
  /** A CMS client to read from; a test passes a stub instead of hitting the network. */
  cms?: SitemapCms
  /** Defaults to the Worker's environment; a test passes one directly. */
  env?: SiteEnv
  /** The clock that decides which jobs are live. */
  now?: Date
  /** The request path: `/sitemap.xml`, or a shard such as `/sitemap-1.xml`. */
  path: string
  /** The canonical origin from `astro.config.mjs` (`site`). */
  siteUrl: string
}

/**
 * Without a CMS URL and site key there is nothing to enumerate, so the route answers 404 rather
 * than an empty sitemap. A published sitemap with no URLs reads to a crawler as "this site has
 * nothing", which is worse than "ask again later".
 */
export const siteSitemap = async ({
  cache,
  cms: givenCms,
  env: givenEnv,
  now,
  path,
  siteUrl,
}: SiteSitemapOptions): Promise<Response> => {
  const env = givenEnv ?? (await siteEnv())
  const cmsUrl = env.CMS_URL?.trim()
  const siteKey = env.SITE_KEY?.trim()

  if (!cmsUrl || !siteKey) {
    return new Response('Sitemap is not configured', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      status: 404,
    })
  }

  return serveSitemap({
    cache,
    cms: givenCms ?? createCmsClient({ baseUrl: cmsUrl, siteKey }),
    ...(now ? { now } : {}),
    path,
    site: siteTenant.slug ?? 'site',
    siteUrl,
    tenant: siteTenant,
  })
}
