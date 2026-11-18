/**
 * Edge cache helper on the Workers Cache API.
 *
 * Entries are addressed by a synthetic URL. Tags work by versioning: each tag has a version
 * stored in the cache, and an entry's address includes the versions of its tags. Purging a
 * tag writes a new version, so every entry stored under the old one becomes unreachable
 * (and expires on its own TTL). Entries also carry a `Cache-Tag` header, so a zone-level
 * purge by tag can be added later without changing callers.
 *
 * Limit: the Workers Cache API is per data centre. `purgeTags` only affects the colo that
 * runs it; cross-colo invalidation (PJ-41) needs a shared store or the zone purge API.
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
