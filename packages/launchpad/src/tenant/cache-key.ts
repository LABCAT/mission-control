/**
 * Cache keys and canonical URLs for the public pages (PJ-41).
 *
 * A public page is cached at the edge under a key built from its URL. The key must be the same
 * for every URL that names the same page, or one page fills the cache with dozens of entries; and
 * it must differ for every URL that names a different page, or one page is served under another's
 * address. Junk therefore never reaches the CMS: unknown parameters, a value that could not be a
 * filter, a duplicate and `?page=1` are dropped before the lookup, and if that changed the URL the
 * browser is sent (301) to the canonical one.
 *
 * Tracking parameters (`utm_*`, `gclid`, ...) are the exception: they are ignored when building
 * the key but kept in the URL, and never redirect, so client-side analytics still sees them.
 */
import { readContentVersion, type ContentVersionStore } from '@mission-control/content-cache'

import type { FilterValues } from './filters'
import { isTrackingParam, type TrackingParamOptions } from './tracking'

/** The highest page any listing serves; past it every number is the same page. */
export const MAX_CACHE_PAGE = 500

const DEFAULT_KEYWORD_LENGTH = 100
/** A taxonomy slug as a URL carries it; anything else cannot name a filter. */
const SLUG_PATTERN = /^[\w-]{1,64}$/

export type CacheParamRule =
  | { kind: 'flag'; name: string; value: string }
  | { kind: 'keyword'; maxLength?: number; name: string }
  | { kind: 'page'; max?: number; name: string }
  | { kind: 'value'; name: string; pattern?: RegExp }

export type CacheQueryReading = { page: number; values: FilterValues }

const toParams = (search: null | string | URLSearchParams): URLSearchParams =>
  typeof search === 'string' ? new URLSearchParams(search) : (search ?? new URLSearchParams())

const clampPage = (raw: string, max: number): number => {
  const requested = /^\d{1,12}$/.test(raw) ? Number(raw) : 1

  return Math.min(Math.max(1, requested), max)
}

/**
 * Read the parameters a page owns, dropping everything else. The same reading feeds the cache key
 * and the CMS query, so a filter this drops is a filter the page does not apply.
 */
export const readCacheQuery = (
  search: null | string | URLSearchParams,
  rules: readonly CacheParamRule[],
): CacheQueryReading => {
  const params = toParams(search)
  const values: FilterValues = {}
  let page = 1

  for (const rule of rules) {
    const raw = params.get(rule.name)?.trim()
    if (!raw) continue

    if (rule.kind === 'page') {
      page = clampPage(raw, rule.max ?? MAX_CACHE_PAGE)
      continue
    }
    if (rule.kind === 'keyword') {
      // Cut, not dropped: dropping a long search would key it as the unfiltered page.
      values[rule.name] = raw.slice(0, rule.maxLength ?? DEFAULT_KEYWORD_LENGTH)
      continue
    }
    if (rule.kind === 'flag') {
      if (raw === rule.value) values[rule.name] = raw
      continue
    }
    if (!(rule.pattern ?? SLUG_PATTERN).test(raw)) continue
    values[rule.name] = raw
  }

  return { page, values }
}

/** The canonical query string: values in alphabetical order, the page last, empties omitted. */
export const cacheQueryString = (values: FilterValues, page: number): string => {
  const params = new URLSearchParams()

  for (const name of Object.keys(values).toSorted()) {
    const value = values[name]?.trim()
    if (value) params.set(name, value)
  }
  if (page > 1) params.set('page', String(page))

  return params.toString()
}

export type ReconciledQuery = {
  /** True when the canonical URL differs from the one requested, so it is a 301. */
  changed: boolean
  /** The canonical path and query, tracking parameters kept where they were. */
  url: string
  /** The same without the tracking parameters: the cache identity, so `utm_*` values share an entry. */
  keyUrl: string
}

/**
 * The canonical URL for a set of already-read filters, plus whether the request should redirect.
 *
 * Tracking parameters are appended exactly as they arrived and never count towards `changed`:
 * stripping them would lose the client-side analytics the visitor arrived with.
 */
export const reconcileCacheQuery = ({
  page,
  pathname,
  search,
  tracking,
  values,
}: {
  page: number
  pathname: string
  search: null | string | URLSearchParams
  tracking?: TrackingParamOptions
  values: FilterValues
}): ReconciledQuery => {
  const params = toParams(search)

  const trackingParams = new URLSearchParams()
  const requested = new URLSearchParams()
  for (const [name, value] of params) {
    if (isTrackingParam(name, tracking)) trackingParams.append(name, value)
    else requested.append(name, value)
  }

  const query = cacheQueryString(values, page)
  const canonical = [query, trackingParams.toString()].filter(Boolean).join('&')

  return {
    changed: requested.toString() !== query,
    keyUrl: query ? `${pathname}?${query}` : pathname,
    url: canonical ? `${pathname}?${canonical}` : pathname,
  }
}

export type NormaliseOptions = {
  pathname: string
  rules: readonly CacheParamRule[]
  /** The request's raw query string. */
  search: null | string | URLSearchParams
  tracking?: TrackingParamOptions
}

/**
 * The canonical URL and cache identity for a request: the parameters the page owns, normalised
 * and ordered, with the tracking parameters appended exactly as they arrived.
 *
 * `changed` is true when the URL's own parameters differ from the canonical ones, which is the
 * case for a 301.
 */
export const normaliseCacheRequest = ({
  pathname,
  rules,
  search,
  tracking,
}: NormaliseOptions): ReconciledQuery => {
  const { page, values } = readCacheQuery(search, rules)

  return reconcileCacheQuery({ page, pathname, search, tracking, values })
}

export type CacheKeyOptions = {
  /**
   * The tenant's content version (PJ-41). A CMS write bumps it, so every data centre misses and
   * re-renders instead of relying on a per-colo `purgeTags`.
   */
  version: string
  site: string
  /** The canonical path and query, from `normaliseCacheRequest`. */
  url: string
}

/** The edge cache key: one tenant's page, at one content version. */
export const contentCacheKey = ({ site, url, version }: CacheKeyOptions): string =>
  `${site}:html:${version}:${url}`

/** The tenant's version from the shared store, or the default when the store has none. */
export const siteContentVersion = async (
  store: ContentVersionStore | undefined,
  site: string,
): Promise<string> => readContentVersion(store, site)
