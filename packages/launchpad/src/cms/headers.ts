/**
 * Cache lifetimes agreed for the job sites (PJ-41, decision of 19 Nov).
 *
 * The edge holds HTML for seven days because the per-tenant content version in the cache key is
 * what invalidates it: a CMS write bumps the version, so every data centre misses at once. A
 * browser cannot be purged, so HTML carries a short browser max-age instead, and a shared cache
 * between the browser and the edge may keep the long copy.
 */

export const HTML_EDGE_TTL_SECONDS = 7 * 24 * 60 * 60

/** The browser revalidates this often; it re-renders under a new version long before this. */
export const HTML_BROWSER_MAX_AGE_SECONDS = 60

/** Content hashes change with the bytes, so a hashed asset is safe to hold for a year. */
export const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** R2 media keeps its key for a year; a replaced image gets a new key. */
export const MEDIA_CACHE_CONTROL = 'public, max-age=31536000'

/** Health checks, account pages and forms must never be held by anything. */
export const NO_STORE_CACHE_CONTROL = 'no-store'

/**
 * The `Cache-Control` an edge cache entry is stored with, and the one a page answers a browser
 * with when the two differ: `s-maxage` lets a shared cache keep the long copy the browser may
 * not.
 */
export const htmlCacheControl = (
  edgeTtl: number,
  browserMaxAge: number = HTML_BROWSER_MAX_AGE_SECONDS,
): { browser: string; edge: string } => ({
  browser: `public, max-age=${Math.floor(browserMaxAge)}, s-maxage=${Math.floor(edgeTtl)}`,
  edge: `public, max-age=${Math.floor(edgeTtl)}`,
})
