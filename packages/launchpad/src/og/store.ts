/**
 * Where a generated share image lives (PJ-105): R2 for the PNG, the Workers Cache API for the
 * edge, and a content version that makes both of them invalidate themselves.
 *
 * The version is a digest of the card, so it changes exactly when something the image shows
 * changes — a new title, a new job type, a new tenant colour. A changed job therefore needs no
 * purge call: its next request computes a new version, misses both stores, and regenerates. The
 * R2 object is overwritten in place (keyed without the version), so storage stays bounded; the
 * edge entry is keyed with the version, so it is simply never read again and expires on its TTL.
 */
import type { CacheLike } from '../cms/cache'
import { OG_HEIGHT, OG_WIDTH } from './card'

/** The part of an R2 bucket this module uses. A real `R2Bucket` satisfies it. */
export type PngBucket = {
  get(key: string): Promise<null | {
    arrayBuffer(): Promise<ArrayBuffer>
    customMetadata?: Record<string, string>
  }>
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      customMetadata?: Record<string, string>
      httpMetadata?: { cacheControl?: string; contentType?: string }
    },
  ): Promise<unknown>
}

export type OgStoreOptions = {
  bucket?: PngBucket
  cache?: CacheLike
  /** Cache and tag namespace. Default `og`. */
  namespace?: string
  /** How long an edge entry lives. Default 7 days; the version makes it safe. */
  ttlSeconds?: number
}

const ORIGIN = 'https://og.mission-control.invalid'
/** A share image is immutable for its version, so it may be held for a long time. */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7
const CACHE_CONTROL = `public, max-age=${DEFAULT_TTL_SECONDS}, immutable`

export const PNG_CONTENT_TYPE = 'image/png'

const defaultCache = (): CacheLike | undefined =>
  (globalThis as { caches?: { default?: CacheLike } }).caches?.default

/** JSON with object keys sorted, so the digest depends on the card's content, not its key order. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item as object).toSorted(([left], [right]) => left.localeCompare(right)))
      : item,
  )

/**
 * The digest of a card, as a short hex string. Over the card's own JSON, so it covers every
 * field the image draws and nothing else: a comment edited on a job does not regenerate a PNG.
 */
export const cardVersion = async (card: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(canonical(card))
  const digest = await crypto.subtle.digest('SHA-256', bytes)

  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const edgeRequest = (namespace: string, key: string, version: string): Request =>
  new Request(`${ORIGIN}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}?v=${version}`)

const response = (body: ArrayBuffer, version: string): Response =>
  new Response(body, {
    headers: {
      'cache-control': CACHE_CONTROL,
      'content-length': String(body.byteLength),
      'content-type': PNG_CONTENT_TYPE,
      etag: `"${version}"`,
      'x-og-version': version,
    },
  })

/**
 * The PNG for `key` at `version`, from the edge, from R2, or freshly rendered.
 *
 * Only a 200 is ever stored, so a render that throws is retried on the next request. A missing
 * bucket or cache is not fatal: the image is still rendered and returned.
 */
export const servedPng = async (
  key: string,
  version: string,
  render: () => Promise<Uint8Array>,
  { bucket, cache = defaultCache(), namespace = 'og', ttlSeconds = DEFAULT_TTL_SECONDS }: OgStoreOptions = {},
): Promise<Response> => {
  const request = edgeRequest(namespace, key, version)

  if (cache && ttlSeconds > 0) {
    try {
      const hit = await cache.match(request)
      if (hit) return hit
    } catch {
      // An unreadable entry is a miss.
    }
  }

  const stored = bucket ? await bucket.get(key).catch(() => null) : null
  if (stored?.customMetadata?.version === version) {
    const body = await stored.arrayBuffer()
    await cache?.put(request, response(body, version)).catch(() => undefined)

    return response(body, version)
  }

  const png = await render()
  // `slice` rather than the view itself: R2 and `Response` both want an ArrayBuffer they own.
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer

  await bucket
    ?.put(key, body, {
      customMetadata: { height: String(OG_HEIGHT), version, width: String(OG_WIDTH) },
      httpMetadata: { cacheControl: CACHE_CONTROL, contentType: PNG_CONTENT_TYPE },
    })
    .catch(() => undefined)
  await cache?.put(request, response(body, version)).catch(() => undefined)

  return response(body, version)
}

/** The R2 key for a card: one object per page, overwritten as the page changes. */
export const ogKey = (kind: string, site: string, slug?: string): string =>
  ['og', kind, site, ...(slug ? [slug] : [])].map((part) => encodeURIComponent(part)).join('/')
