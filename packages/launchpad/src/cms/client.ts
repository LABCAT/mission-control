import type {
  CmsCollectionSlug,
  CmsDoc,
  CmsFindOptions,
  CmsGlobal,
  CmsGlobalSlug,
  CmsList,
  CmsQuery,
} from './types'

/** Header the CMS reads the per-site key from (PJ-07). */
export const SITE_KEY_HEADER = 'x-site-key'

export type CmsClientOptions = {
  /** CMS origin, e.g. `https://cms.example.com`. Always supplied by the site; never defaulted here. */
  baseUrl: string
  /** Replaceable for tests or a service binding. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** The site key. Keep it in a server-only env var. */
  siteKey: string
  /** Abort a request after this many milliseconds. Default 10 000. */
  timeoutMs?: number
}

export type CmsErrorCode = 'http' | 'invalid_response' | 'network' | 'timeout'

/** Thrown for every failure. The message and `url` never contain the site key. */
export class CmsError extends Error {
  readonly code: CmsErrorCode
  /** HTTP status, when the CMS answered. */
  readonly status?: number
  readonly url: string

  constructor(code: CmsErrorCode, message: string, url: string, status?: number, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'CmsError'
    this.code = code
    this.status = status
    this.url = url
  }

  get isNotFound(): boolean {
    return this.status === 404
  }
}

/**
 * Serialise a nested value the way Payload's REST API parses it (`qs` bracket notation):
 * `{ where: { status: { equals: 'published' } } }` becomes `where[status][equals]=published`.
 */
export const stringifyQuery = (params: Record<string, unknown>): string => {
  const pairs: string[] = []

  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      value.forEach((item, index) => add(`${key}[${index}]`, item))
    } else if (value instanceof Date) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value.toISOString())}`)
    } else if (typeof value === 'object') {
      for (const [child, childValue] of Object.entries(value)) add(`${key}[${child}]`, childValue)
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
  }

  for (const [key, value] of Object.entries(params)) add(key, value)

  return pairs.join('&')
}

const queryParams = (query: CmsFindOptions): Record<string, unknown> => ({
  depth: query.depth,
  draft: query.draft,
  limit: query.limit,
  locale: query.locale,
  page: query.page,
  select: query.select,
  sort: Array.isArray(query.sort) ? query.sort.join(',') : query.sort,
  where: query.where,
})

export type CmsClient = {
  /**
   * Every matching document, in one request. No pagination: the founder decision is that
   * listings show all live jobs and all organisations on a single page.
   */
  findAll<K extends CmsCollectionSlug>(collection: K, query?: CmsQuery): Promise<CmsDoc<K>[]>
  /** The first document with this id, or `null` on a 404. */
  findByID<K extends CmsCollectionSlug>(
    collection: K,
    id: number | string,
    query?: Pick<CmsQuery, 'depth' | 'draft' | 'locale' | 'select'>,
  ): Promise<CmsDoc<K> | null>
  /**
   * The first document with this slug, or `null`. It adds no status filter on purpose, so a
   * detail page still resolves for a document the list hides (an expired job). Access control
   * on the CMS decides what a site key can see.
   */
  findBySlug<K extends CmsCollectionSlug>(
    collection: K,
    slug: string,
    query?: Omit<CmsQuery, 'sort' | 'where'>,
  ): Promise<CmsDoc<K> | null>
  /** One page of results, with Payload's pagination metadata. */
  find<K extends CmsCollectionSlug>(
    collection: K,
    options?: CmsFindOptions,
  ): Promise<CmsList<CmsDoc<K>>>
  global<K extends CmsGlobalSlug>(
    slug: K,
    query?: Pick<CmsQuery, 'depth' | 'draft' | 'locale' | 'select'>,
  ): Promise<CmsGlobal<K>>
  /**
   * This site's own settings (PJ-37), resolved from its key. `null` when the CMS has none, so a
   * site falls back to its own branding instead of failing.
   */
  tenantSettings(): Promise<CmsTenantSettings | null>
}

/** The public settings the plugin's `GET /api/tenant-settings` returns (PJ-37). */
export type CmsTenantSettings = {
  accountRequiredToApply?: boolean
  branding?: { colorAccent?: null | string; colorHover?: null | string; colorPrimary?: null | string } | null
  currency?: string
  currencyMinorUnits?: number
  defaultLocale?: string
  expiredJobGoneAfterMonths?: number
  expiredJobMode?: string
  /** Resolved jobs slug (PJ-80). */
  jobsSlug?: string
  locales?: { locale?: string }[]
  name: string
  publicJobViews?: boolean
  slug: string
  timezone?: string
}

/**
 * Typed client for the CMS REST API, authenticated with a site key.
 *
 * Server-side only. The key authenticates a whole site, so it must never reach a browser:
 * the constructor throws if it runs where `window` exists.
 */
export const createCmsClient = (options: CmsClientOptions): CmsClient => {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new Error('createCmsClient is server-side only: the site key must never reach the browser')
  }

  const siteKey = options.siteKey?.trim()
  if (!siteKey) throw new Error('createCmsClient: siteKey is required')

  let origin: string
  try {
    origin = new URL(options.baseUrl).origin
  } catch {
    throw new Error('createCmsClient: baseUrl must be an absolute URL')
  }

  const timeoutMs = options.timeoutMs ?? 10_000

  const request = async <T>(path: string, params: Record<string, unknown> = {}): Promise<T | null> => {
    const query = stringifyQuery(params)
    const url = `${origin}/api/${path}${query ? `?${query}` : ''}`
    const doFetch = options.fetch ?? fetch

    let response: Response
    try {
      response = await doFetch(url, {
        headers: { accept: 'application/json', [SITE_KEY_HEADER]: siteKey },
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      throw new CmsError(
        timedOut ? 'timeout' : 'network',
        timedOut ? `CMS request timed out after ${timeoutMs}ms` : 'CMS request failed',
        url,
        undefined,
        error,
      )
    }

    if (response.status === 404) return null

    if (!response.ok) {
      throw new CmsError('http', `CMS responded ${response.status}`, url, response.status)
    }

    try {
      return (await response.json()) as T
    } catch (error) {
      throw new CmsError('invalid_response', 'CMS returned a body that is not JSON', url, response.status, error)
    }
  }

  const required = async <T>(path: string, params?: Record<string, unknown>): Promise<T> => {
    const body = await request<T>(path, params)
    if (body === null) {
      throw new CmsError('http', 'CMS responded 404', `${origin}/api/${path}`, 404)
    }

    return body
  }

  const find: CmsClient['find'] = (collection, findOptions = {}) =>
    required(collection, queryParams(findOptions))

  return {
    find,
    async findAll(collection, query = {}) {
      // `limit=0` is Payload's "no limit"; `pagination=false` skips the count query.
      const result = await required<CmsList<never>>(collection, {
        ...queryParams(query),
        limit: 0,
        pagination: false,
      })

      return result.docs
    },
    async findByID(collection, id, query = {}) {
      return request(`${collection}/${encodeURIComponent(String(id))}`, queryParams(query))
    },
    async findBySlug(collection, slug, query = {}) {
      const result = await required<CmsList<never>>(collection, {
        ...queryParams(query),
        limit: 1,
        where: { slug: { equals: slug } },
      })

      return result.docs[0] ?? null
    },
    global: (slug, query = {}) => required(`globals/${slug}`, queryParams(query)),
    tenantSettings: () => request<CmsTenantSettings>('tenant-settings'),
  }
}
