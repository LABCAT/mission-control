/**
 * Serve one public page through the edge cache, with the content-version key and the 301 for a
 * non-canonical URL (PJ-41).
 *
 * ```ts
 * return servePublicPage({
 *   normalise: { pathname: Astro.url.pathname, rules: [], search: Astro.url.search, tracking },
 *   render: () => renderPage(),
 *   site: tenant.slug,
 *   store: env.CONTENT_CACHE,
 * })
 * ```
 */
import {
  DEFAULT_CONTENT_VERSION,
  readContentVersion,
  type ContentVersionStore,
} from '@mission-control/content-cache'

import { cacheTag, cachedResponse, type CacheLike } from '../cms/cache'
import { HTML_BROWSER_MAX_AGE_SECONDS, HTML_EDGE_TTL_SECONDS, htmlCacheControl } from '../cms/headers'
import { contentCacheKey, normaliseCacheRequest, type NormaliseOptions } from './cache-key'

export type PublicPageOptions = {
  /** Defaults to `caches.default`; with no cache the page renders on every request. */
  cache?: CacheLike
  /** Where the page lives: the path and query rules that make its cache identity. */
  normalise: NormaliseOptions
  render: () => Promise<Response>
  /** The tenant slug; scopes the key and the purge tag. */
  site: string
  /** The tenant's content version store (KV in production). Absent means version `0`. */
  store: ContentVersionStore | undefined
  /**
   * How long the edge holds the HTML. Default seven days once the tenant has a content version,
   * because the version, not the clock, refreshes it; five minutes while it reads the default
   * (no store, or a store the CMS has never written to), because then nothing can invalidate the
   * entry and the TTL is the only way a change reaches the site.
   */
  ttl?: number
}

/** No store means no invalidation, so the edge copy must expire on its own, as it did before. */
export const FALLBACK_EDGE_TTL_SECONDS = 5 * 60

/**
 * A page reached by a URL that is not canonical answers 301 to the canonical one, and is not
 * cached: the answer depends on the URL asked for, not on the content version.
 */
const redirect = (url: string): Response =>
  new Response(null, {
    headers: { 'cache-control': 'no-store', location: url },
    status: 301,
  })

/**
 * Render a public page under its content-version key.
 *
 * Order matters: the canonical redirect comes before any cache lookup, so a junk URL never reaches
 * the CMS or fills the cache. Tracking parameters are kept by the redirect (they are not part of
 * `changed`), so analytics still sees them.
 */
export const servePublicPage = async ({
  cache,
  normalise,
  render,
  site,
  store,
  ttl,
}: PublicPageOptions): Promise<Response> => {
  const { changed, keyUrl, url } = normaliseCacheRequest(normalise)
  if (changed) return redirect(url)

  const version = await readContentVersion(store, site)
  // Long only when a version has actually been written: a store that always reads the default
  // (an empty namespace the CMS never bumps) cannot invalidate anything, so the clock must.
  const edgeTtl = ttl ?? (version === DEFAULT_CONTENT_VERSION ? FALLBACK_EDGE_TTL_SECONDS : HTML_EDGE_TTL_SECONDS)

  return cachedResponse(contentCacheKey({ site, url: keyUrl, version }), edgeTtl, render, {
    browserCacheControl: htmlCacheControl(edgeTtl, HTML_BROWSER_MAX_AGE_SECONDS).browser,
    cache,
    tags: [cacheTag('site', site)],
  })
}
