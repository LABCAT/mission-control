import type { APIRoute } from 'astro'

import { sitemapShardNumber } from '@mission-control/launchpad/seo/serve'

import { siteSitemap } from '../sitemap'

/**
 * `/sitemap-[shard].xml`. Only a site with more URLs than one file may hold has shards; any
 * other shard number is a 404, so a shrinking site never leaves an old list in a crawler's hands.
 */
export const GET: APIRoute = ({ site, url }) => {
  if (sitemapShardNumber(url.pathname) === null) {
    return new Response('Not found', { headers: { 'content-type': 'text/plain' }, status: 404 })
  }

  return siteSitemap({ path: url.pathname, siteUrl: site ? site.origin : url.origin })
}
