/**
 * Edge cache helper on the Workers Cache API.
 *
 * Entries are addressed by a synthetic URL. Tags work by versioning: each tag has a version
 * stored in the cache, and an entry's address includes the versions of its tags. Purging a
 * tag writes a new version, so every entry stored under the old one becomes unreachable
 * (and expires on its own TTL). Entries also carry a `Cache-Tag` header, so a zone-level
 * purge by tag can be added later without changing callers.
 *
 * Limit: the Workers Cache API is per data centre, so `purgeTags` only affects the colo that runs
 * it. Global invalidation is the per-tenant content version in Cloudflare KV: it goes into the key
 * of every page (see `tenant/cache-key.ts`), and the CMS bumps it on a write (PJ-41). `purgeTags`
 * remains for the JSON reads within a colo, where a stale copy is harmless.
 */

/** The slice of the Cache API used here; `caches.default` satisfies it. */
export type CacheLike = {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export type CachedOptions = {
  /** Defaults to `caches.default`. With no cache available `cached` just calls `fn`. */
  cache?: CacheLike
  /** Keeps unrelated users of the cache apart. Default `mc`. */
  namespace?: string
  /** Purge tags for this entry, e.g. `site:vwok`, `jobs`. */
  tags?: readonly string[]
}

const ORIGIN = 'https://cache.mission-control.invalid'
/** Tag versions outlive any entry: a purge must not be forgotten while an entry is live. */
const TAG_TTL_SECONDS = 60 * 60 * 24 * 31
export const MAX_TTL_SECONDS = 60 * 60 * 24 * 30

/** Build a purge tag from parts, e.g. `cacheTag('site', siteSlug, 'jobs')` is `site:vwok:jobs`. */
export const cacheTag = (...parts: string[]): string => parts.join(':')

const defaultCache = (): CacheLike | undefined =>
  (globalThis as { caches?: { default?: CacheLike } }).caches?.default

const tagRequest = (namespace: string, tag: string): Request =>
  new Request(`${ORIGIN}/${encodeURIComponent(namespace)}/tag/${encodeURIComponent(tag)}`)

const readVersion = async (cache: CacheLike, namespace: string, tag: string): Promise<string> => {
  const hit = await cache.match(tagRequest(namespace, tag))

  return hit ? await hit.text() : '0'
}

const entryRequest = (namespace: string, key: string, versions: readonly string[]): Request =>
  new Request(
    `${ORIGIN}/${encodeURIComponent(namespace)}/entry/${encodeURIComponent(key)}?v=${versions.map(encodeURIComponent).join(',')}`,
  )

const sortedUnique = (tags: readonly string[] | undefined): string[] => [...new Set(tags ?? [])].toSorted()

/**
 * Return the cached value for `key`, or run `fn`, store its result for `ttl` seconds and
 * return it. Errors from `fn` are never cached. A cache that fails is skipped, not fatal.
 *
 * The key is the caller's whole identity for the value: include the site and anything that
 * changes the result (filters, locale). Values must be JSON; `undefined` is not stored.
 */
export const cached = async <T>(
  key: string,
  ttl: number,
  fn: () => Promise<T>,
  options: CachedOptions = {},
): Promise<T> => {
  const cache = options.cache ?? defaultCache()
  if (!cache || !(ttl > 0)) return fn()

  const namespace = options.namespace ?? 'mc'
  const tags = sortedUnique(options.tags)

  let request: Request | undefined
  try {
    const versions = await Promise.all(tags.map((tag) => readVersion(cache, namespace, tag)))
    request = entryRequest(namespace, key, versions.map((version, index) => `${tags[index]}@${version}`))

    const hit = await cache.match(request)
    if (hit) return (await hit.json()) as T
  } catch {
    // Unreadable or corrupt entry: treat as a miss.
  }

  const value = await fn()
  if (value === undefined || !request) return value

  try {
    const headers = new Headers({
      'cache-control': `public, max-age=${Math.floor(Math.min(ttl, MAX_TTL_SECONDS))}`,
      'content-type': 'application/json',
    })
    if (tags.length > 0) headers.set('cache-tag', tags.join(','))
    await cache.put(request, new Response(JSON.stringify(value), { headers }))
  } catch {
    // Storing is best effort.
  }

  return value
}

/**
 * The Cache API can store a `Response` whole, which is what a rendered page needs: the HTML
 * body and its headers. `cached` above stores JSON, so a page uses this instead.
 */
export type CachedResponseOptions = Pick<CachedOptions, 'cache' | 'namespace' | 'tags'> & {
  /**
   * What a browser is told. The entry itself is stored for `ttl` (the edge copy), so a page can be
   * held at the edge for days while the browser revalidates every minute; see `cms/headers.ts`.
   */
  browserCacheControl?: string
}

const responseRequest = (namespace: string, key: string, versions: readonly string[]): Request =>
  new Request(
    `${ORIGIN}/${encodeURIComponent(namespace)}/page/${encodeURIComponent(key)}?v=${versions
      .map(encodeURIComponent)
      .join(',')}`,
  )

const withBrowserCache = (response: Response, browserCacheControl: string | undefined): Response => {
  if (!browserCacheControl) return response

  const headers = new Headers(response.headers)
  headers.set('cache-control', browserCacheControl)

  return new Response(response.body, { headers, status: response.status })
}

/**
 * Store a rendered page for `ttl` seconds under `key`, tagged for purging, and return it.
 *
 * `ttl <= 0` or no cache runs `render` every time: a preview must not be held. A cache that
 * fails is skipped, not fatal, and `render`'s own errors are never cached. Only a 200 is stored,
 * because a 404 is this URL's real answer and would otherwise outlive a fix. `Cache-Control`
 * and `Cache-Tag` are written here, so the page cannot be held longer than the caller said.
 *
 * A page that comes back `Cache-Control: no-store` is passed through untouched: a caller that
 * knows this response does not belong to its own key must be able to say so, or the cache would
 * hold one URL's HTML under another's.
 */
export const cachedResponse = async (
  key: string,
  ttl: number,
  render: () => Promise<Response>,
  options: CachedResponseOptions = {},
): Promise<Response> => {
  const cache = options.cache ?? defaultCache()
  if (!cache || !(ttl > 0)) return render()

  const namespace = options.namespace ?? 'mc'
  const tags = sortedUnique(options.tags)

  let request: Request | undefined
  try {
    const versions = await Promise.all(tags.map((tag) => readVersion(cache, namespace, tag)))
    request = responseRequest(
      namespace,
      key,
      versions.map((version, index) => `${tags[index]}@${version}`),
    )

    const hit = await cache.match(request)
    // A stored page carries the edge lifetime; a browser must get the short one even on a hit.
    if (hit) return withBrowserCache(hit, options.browserCacheControl)
  } catch {
    // Unreadable entry: treat it as a miss.
  }

  const response = await render()
  // A response that sets a cookie is for one visitor: never store it for everyone.
  const refusable =
    /\bno-store\b/i.test(response.headers.get('cache-control') ?? '') || response.headers.has('set-cookie')
  if (!request || response.status !== 200 || refusable) return response

  const body = await response.text()
  const stored = new Headers(response.headers)
  stored.set('cache-control', `public, max-age=${Math.floor(Math.min(ttl, MAX_TTL_SECONDS))}`)
  if (tags.length > 0) stored.set('cache-tag', tags.join(','))

  try {
    await cache.put(request, new Response(body, { headers: stored, status: 200 }))
  } catch {
    // Storing is best effort.
  }

  return withBrowserCache(new Response(body, { headers: stored, status: 200 }), options.browserCacheControl)
}

/** Invalidate every entry stored with any of these tags (in this colo; see the file note). */
export const purgeTags = async (
  tags: readonly string[],
  options: Pick<CachedOptions, 'cache' | 'namespace'> = {},
): Promise<void> => {
  const cache = options.cache ?? defaultCache()
  if (!cache) return

  const namespace = options.namespace ?? 'mc'
  const version = crypto.randomUUID()

  await Promise.all(
    sortedUnique(tags).map((tag) =>
      cache.put(
        tagRequest(namespace, tag),
        new Response(version, {
          headers: { 'cache-control': `public, max-age=${TAG_TTL_SECONDS}` },
        }),
      ),
    ),
  )
}
