import type { APIRoute } from 'astro'

import { siteEnv } from '../env'
import { allowAiCrawlersFor, robotsTxt } from '../robots'
import { cmsFromEnv } from '../site'

/**
 * `/robots.txt`. The sitemap line is the canonical origin from `astro.config.mjs`, so a preview
 * host that is allowed to crawl still points at the live sitemap rather than its own copy.
 *
 * The AI-crawler group follows the tenant's `allowAiCrawlers` setting (PJ-104). If the settings
 * cannot be read the site keeps its legacy answer (allow), so a CMS blip never changes what a
 * crawler may do. `AI_CRAWLERS_ALLOWED` is only consulted when there is no CMS at all.
 */
export const GET: APIRoute = async ({ site, url }) => {
  const env = await siteEnv()
  const cms = cmsFromEnv(env)
  const settings = cms ? await cms.tenantSettings().catch(() => null) : null
  const siteUrl = site ? site.origin : undefined

  return new Response(
    robotsTxt(url.hostname, {
      aiCrawlersAllowed: allowAiCrawlersFor({ env, settings }),
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
