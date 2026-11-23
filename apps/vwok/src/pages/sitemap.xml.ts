import type { APIRoute } from 'astro'

import { siteSitemap } from '../sitemap'

/** `/sitemap.xml`: one `urlset`, or an index once the site outgrows one file. */
export const GET: APIRoute = ({ site, url }) =>
  siteSitemap({ path: url.pathname, siteUrl: site ? site.origin : url.origin })
