/**
 * Tracking parameters are ignored when a URL becomes a cache key, but they stay in the URL: the
 * site's analytics (Cloudflare Zaraz, GA) reads them client-side, and a redirect would throw them
 * away. A link with `?utm_source=chatgpt.com` therefore shares a cache entry with the same page
 * without it, and is never rewritten (PJ-41, decision of 19 Nov).
 */

/** Prefix match: any `utm_*` parameter. */
const TRACKING_PREFIXES = ['utm_'] as const

/** Exact names. `ref` is last because it is the most likely to be a real parameter one day. */
export const DEFAULT_TRACKING_PARAMS: readonly string[] = [
  'fbclid',
  'gbraid',
  'gclid',
  'li_fat_id',
  'msclkid',
  'ref',
  'ttclid',
  'wbraid',
]

export type TrackingParamOptions = {
  /** The tenant's extra names, on top of `DEFAULT_TRACKING_PARAMS`. */
  extra?: readonly string[]
}

/** True when `name` is a tracking parameter that the cache key must ignore and the URL keep. */
export const isTrackingParam = (name: string, options: TrackingParamOptions = {}): boolean => {
  const lowered = name.toLowerCase()

  return (
    TRACKING_PREFIXES.some((prefix) => lowered.startsWith(prefix)) ||
    DEFAULT_TRACKING_PARAMS.includes(lowered) ||
    (options.extra ?? []).some((extra) => extra.toLowerCase() === lowered)
  )
}

/** The tracking parameters of a query string, in their original order, untouched. */
export const trackingParams = (
  search: null | string | URLSearchParams,
  options: TrackingParamOptions = {},
): [string, string][] => {
  const params = typeof search === 'string' ? new URLSearchParams(search) : (search ?? new URLSearchParams())

  return [...params.entries()].filter(([name]) => isTrackingParam(name, options))
}
