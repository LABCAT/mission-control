import { servePublicPage } from '@mission-control/launchpad/tenant/page-cache'
import { contentVersionStore } from '@mission-control/launchpad/tenant/store'

import { SITE_SLUG } from './brand'
import type { SiteEnv } from './env'

/**
 * Which requests the public edge cache may serve (PJ-41). Pages only: the account area, the API,
 * `/health` and anything with a file extension (sitemaps, robots, assets) answer for themselves.
 * `/account` and forms are never cached; a form is a POST, which this never touches.
 */
// `/jobs` is the listing, which caches itself under its own filters (`serveJobListing`): this
// middleware has no parameter rules, so it would 301 every filter away.
const UNCACHED_PREFIXES = ['/account', '/api', '/health', '/jobs', '/_'] as const

export const isCacheablePath = (pathname: string): boolean =>
  !UNCACHED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) &&
  !pathname.startsWith('/_') &&
  !/\.[a-z0-9]{1,8}$/i.test(pathname)

/**
 * Serve a public page through the edge cache under the tenant's content version, redirecting a
 * non-canonical URL first. The public pages take no query parameters of their own, so any
 * parameter that is not a tracking one is dropped by a 301.
 */
export const servePublic = ({
  env,
  next,
  request,
}: {
  env: SiteEnv & { CONTENT_CACHE?: unknown }
  next: () => Promise<Response>
  request: Request
}): Promise<Response> | null => {
  const url = new URL(request.url)
  if (request.method !== 'GET' || !isCacheablePath(url.pathname)) return null

  return servePublicPage({
    normalise: { pathname: url.pathname, rules: [], search: url.search },
    render: next,
    site: SITE_SLUG,
    store: contentVersionStore(env),
  })
}
