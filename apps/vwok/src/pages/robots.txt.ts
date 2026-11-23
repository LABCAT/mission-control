import type { APIRoute } from 'astro'

import { aiCrawlersAllowed, siteEnv } from '../env'
import { robotsTxt } from '../robots'

/**
 * `/robots.txt`. The sitemap line is the canonical origin from `astro.config.mjs`, so a preview
 * host that is allowed to crawl still points at the live sitemap rather than its own copy.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const env = await siteEnv()
  const siteUrl = site ? site.origin : undefined

  return new Response(
    robotsTxt(url.hostname, {
      aiCrawlersAllowed: aiCrawlersAllowed(env),
      sitemapUrl: siteUrl ? `${siteUrl}/sitemap.xml` : null,
    }),
    {
      headers: {
        'cache-control': 'public, max-age=3600',
        'content-type': 'text/plain; charset=utf-8',
      },
    },
  )
}
