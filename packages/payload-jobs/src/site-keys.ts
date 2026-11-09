import type { AccessArgs, AccessResult, PayloadRequest } from 'payload'

/**
 * Site keys let a public site read content without a user session.
 *
 * - The key is 32 random bytes from the platform CSPRNG, base64url encoded.
 * - Only the SHA-256 digest is stored; the raw key is shown once on creation.
 * - A site key reads only published content. A key on a normal tenant reads that tenant
 *   only; a key on the aggregate tenant reads every tenant.
 */

export const SITE_KEY_HEADER = 'x-site-key'
export const SITE_KEY_BYTES = 32
export const SITE_KEY_PREFIX = 'sk_'

export const SITE_KEY_ACCESS_KEYS = [
  'create',
  'read',
  'update',
  'delete',
  'readVersions',
  'unlock',
  'validate',
] as const

export type SiteKeyAccessKey = (typeof SITE_KEY_ACCESS_KEYS)[number]

export type GeneratedSiteKey = {
  key: string
  keyHash: string
}

export type ResolvedSiteKey = {
  id: number | string
  isAggregate: boolean
  tenantID: number | string
}

type SiteKeyDoc = {
  id: number | string
  tenant?: null | number | string | { id?: number | string; isAggregate?: unknown }
}

const SITE_KEY_CACHE = 'missionControlSiteKeys'

const toHex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('')

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 digest of a raw key, hex encoded. Only this value is persisted. */
export const hashSiteKey = async (rawKey: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey)))

export const generateSiteKey = async (): Promise<GeneratedSiteKey> => {
  const bytes = crypto.getRandomValues(new Uint8Array(SITE_KEY_BYTES))
  const key = `${SITE_KEY_PREFIX}${toBase64Url(bytes)}`

  return { key, keyHash: await hashSiteKey(key) }
}

export const getSiteKeyHeader = (req: PayloadRequest): null | string => {
  const value = req.headers?.get?.(SITE_KEY_HEADER)?.trim()

  return value ? value : null
}

const tenantIDOf = (tenant: SiteKeyDoc['tenant']): null | number | string => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return tenant.id ?? null

  return tenant
}

const isAggregateTenant = (tenant: SiteKeyDoc['tenant']): boolean =>
  typeof tenant === 'object' && tenant !== null && tenant.isAggregate === true

const cacheFor = (req: PayloadRequest): Map<string, Promise<null | ResolvedSiteKey>> => {
  const context = (req.context ??= {})
  const existing = context[SITE_KEY_CACHE]

  if (existing instanceof Map) {
    return existing as Map<string, Promise<null | ResolvedSiteKey>>
  }

  const cache = new Map<string, Promise<null | ResolvedSiteKey>>()
  context[SITE_KEY_CACHE] = cache

  return cache
}

/**
 * Resolve the `x-site-key` header to its tenant. Returns `null` when the header is missing
 * or the key is unknown. The lookup is cached on the request, so one request hashes and
 * queries at most once.
 */
export const resolveSiteKey = async (req: PayloadRequest): Promise<null | ResolvedSiteKey> => {
  const rawKey = getSiteKeyHeader(req)
  if (!rawKey) return null

  const keyHash = await hashSiteKey(rawKey)
  const cache = cacheFor(req)
  const cached = cache.get(keyHash)
  if (cached) return cached

  const resolution = (async (): Promise<null | ResolvedSiteKey> => {
    const result = await req.payload.find({
      collection: 'site-keys',
      depth: 1,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: { keyHash: { equals: keyHash } },
    })

    const doc = result.docs[0] as SiteKeyDoc | undefined
    if (!doc) return null

    const tenantID = tenantIDOf(doc.tenant)
    if (tenantID === null) return null

    return { id: doc.id, isAggregate: isAggregateTenant(doc.tenant), tenantID }
  })()

  cache.set(keyHash, resolution)

  return resolution
}

export type SiteKeyAccessOverrideArgs = AccessArgs & {
  accessKey: SiteKeyAccessKey
  accessResult: AccessResult
}

export type SiteKeyAccessOverrideOptions = {
  /** Collections a site key may read. Keep this explicit and small. */
  allowedCollections: Iterable<string>
}

type CollectionsBySlug = Record<string, undefined | { config?: { versions?: { drafts?: unknown } } }>

/** Payload drafts are the only published-state source: no drafts means everything is live. */
const isDraftEnabled = (req: PayloadRequest, slug: string): boolean => {
  const collections = req.payload.collections as unknown as CollectionsBySlug | undefined

  return Boolean(collections?.[slug]?.config?.versions?.drafts)
}

/**
 * Wrap a collection's access result so an anonymous request carrying a valid site key can
 * read published documents only. A key on a normal tenant is scoped to that tenant; a key on
 * the aggregate tenant reads every tenant. User sessions are untouched, and writes, unknown
 * keys and collections outside the allowlist fail closed.
 *
 * The plugin passes this result straight through for anonymous requests, so the aggregate
 * case needs no tenant constraint and does not get one re-added.
 *
 * Use it as `accessResultOverride` for the collections in the allowlist.
 */
export const createSiteKeyAccessOverride =
  ({ allowedCollections }: SiteKeyAccessOverrideOptions) =>
  async ({
    accessKey,
    accessResult,
    req,
    slug,
  }: SiteKeyAccessOverrideArgs): Promise<AccessResult> => {
    if (req.user) return accessResult

    const rawKey = getSiteKeyHeader(req)
    if (!rawKey) return accessResult

    if (accessKey !== 'read') return false

    if (!new Set(allowedCollections).has(slug)) return false

    const siteKey = await resolveSiteKey(req)
    if (!siteKey) return false

    const published = isDraftEnabled(req, slug)
      ? ({ _status: { equals: 'published' } } as const)
      : null

    if (siteKey.isAggregate) return published ?? true

    const tenantScope: AccessResult = { tenant: { equals: siteKey.tenantID } }
    if (!published) return tenantScope

    return { and: [tenantScope, published] }
  }
