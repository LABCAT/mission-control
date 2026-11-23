/**
 * Per-tenant content versions, held in a store every Worker in the account can read (Cloudflare
 * KV in production, a `Map` in tests and dev).
 *
 * The Workers Cache API is per data centre, so purging a tag only clears the colo that ran the
 * purge. Instead, each site puts its tenant's content version into every edge cache key, and a
 * CMS write bumps the version: every colo misses on its next request and re-renders, whatever
 * copy of the page it held (PJ-41).
 *
 * KV is eventually consistent (up to ~60 s to every colo), so a write is visible to a browser
 * within the HTML browser max-age, and to any colo within the KV propagation window. That is the
 * trade the founder chose over a zone-level purge.
 */

/** The store slice used here; a Cloudflare `KVNamespace` satisfies it. */
export type ContentVersionStore = {
  get: (key: string) => Promise<null | string>
  put: (key: string, value: string) => Promise<void>
}

export const CONTENT_VERSION_KEY_PREFIX = 'content-version:'

/**
 * The scope every aggregate site (the hub) reads. A hub lists several tenants' content, so any
 * tenant's write must invalidate it.
 */
export const ALL_CONTENT_SCOPE = 'all'

/** What an unwritten version reads as. Never a real version, so the first bump always differs. */
export const DEFAULT_CONTENT_VERSION = '0'

/** The KV key for one scope, e.g. `content-version:vwok`. */
export const contentVersionKey = (scope: string): string =>
  `${CONTENT_VERSION_KEY_PREFIX}${scope}`

/**
 * A fresh version. Random rather than a counter: two Workers bumping at once must not write the
 * same value, or one site would keep serving the cache it meant to drop.
 */
export const newContentVersion = (): string => crypto.randomUUID()

/**
 * The current version of `scope`, or `DEFAULT_CONTENT_VERSION` when the store is missing, the
 * key is unset, or the store fails. A cache must never break a page because KV is down: a read
 * error answers from the old version, which is a stale page rather than an error page.
 */
export const readContentVersion = async (
  store: ContentVersionStore | undefined,
  scope: string,
): Promise<string> => {
  if (!store || !scope) return DEFAULT_CONTENT_VERSION

  try {
    return (await store.get(contentVersionKey(scope))) || DEFAULT_CONTENT_VERSION
  } catch {
    return DEFAULT_CONTENT_VERSION
  }
}

/** Read several scopes at once, as one record; a missing or unset scope reads as the default. */
export const readContentVersions = async (
  store: ContentVersionStore | undefined,
  scopes: readonly string[],
): Promise<Record<string, string>> => {
  const unique = [...new Set(scopes.filter(Boolean))]
  const versions = await Promise.all(unique.map((scope) => readContentVersion(store, scope)))

  return Object.fromEntries(unique.map((scope, index) => [scope, versions[index]!]))
}

export type BumpOptions = {
  /** Injectable for tests. Defaults to `newContentVersion`. */
  nextVersion?: () => string
}

/**
 * Bump each scope to a new version and return what it became.
 *
 * Writes are best effort: a KV outage must not fail a CMS save. A scope whose write failed keeps
 * its old version, so that site stays on its cached pages until the next successful change or
 * the entry's own TTL.
 */
export const bumpContentVersions = async (
  store: ContentVersionStore | undefined,
  scopes: readonly string[],
  options: BumpOptions = {},
): Promise<Record<string, string>> => {
  const unique = [...new Set(scopes.filter(Boolean))]
  if (!store || unique.length === 0) return {}

  const next = options.nextVersion ?? newContentVersion
  const bumped: Record<string, string> = {}

  await Promise.all(
    unique.map(async (scope) => {
      const version = next()
      try {
        await store.put(contentVersionKey(scope), version)
        bumped[scope] = version
      } catch {
        // Best effort: see above.
      }
    }),
  )

  return bumped
}

/** A store held in memory. Per isolate, so for tests and `astro dev` only, never production. */
export const createMemoryContentVersionStore = (
  initial: Record<string, string> = {},
): ContentVersionStore & { values: Map<string, string> } => {
  const values = new Map(
    Object.entries(initial).map(([scope, version]) => [contentVersionKey(scope), version]),
  )

  return {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value)
    },
    values,
  }
}
