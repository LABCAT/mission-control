import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  createSiteKeyAccessOverride,
  generateSiteKey,
  hashSiteKey,
  resolveSiteKey,
  SITE_KEY_HEADER,
  SITE_KEY_PREFIX,
} from './site-keys'

type Doc = { id: number; tenant: number | { id: number; isAggregate?: boolean } }

const requestFor = ({
  docs = [],
  drafts = false,
  key,
  user = null,
}: {
  docs?: Doc[]
  drafts?: boolean
  key?: string
  user?: unknown
}) => {
  const find = vi.fn(async () => ({ docs }))
  const headers = new Headers()

  if (key) headers.set(SITE_KEY_HEADER, key)

  const req = {
    context: {},
    headers,
    payload: {
      collections: { media: { config: { versions: { drafts } } } },
      find,
    },
    user,
  } as unknown as PayloadRequest

  return { find, req }
}

const override = createSiteKeyAccessOverride({ allowedCollections: ['media'] })

const args = (
  req: PayloadRequest,
  accessKey: 'create' | 'read',
  slug = 'media',
  accessResult: boolean | object = true,
) => ({ accessKey, accessResult, req, slug }) as never

describe('site key generation', () => {
  it('creates a 32-byte key and stores only its digest', async () => {
    const { key, keyHash } = await generateSiteKey()
    const encoded = key.slice(SITE_KEY_PREFIX.length)

    expect(key.startsWith(SITE_KEY_PREFIX)).toBe(true)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(encoded).toHaveLength(43)
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(keyHash).not.toBe(key)
    expect(await hashSiteKey(key)).toBe(keyHash)
  })

  it('does not reuse a key', async () => {
    const first = await generateSiteKey()
    const second = await generateSiteKey()

    expect(first.key).not.toBe(second.key)
    expect(first.keyHash).not.toBe(second.keyHash)
  })
})

describe('site key resolution', () => {
  it('returns null without the header and does not query', async () => {
    const { find, req } = requestFor({})

    expect(await resolveSiteKey(req)).toBeNull()
    expect(find).not.toHaveBeenCalled()
  })

  it('looks up the digest and returns the tenant', async () => {
    const { key } = await generateSiteKey()
    const { find, req } = requestFor({ docs: [{ id: 1, tenant: 7 }], key })

    expect(await resolveSiteKey(req)).toEqual({ id: 1, isAggregate: false, tenantID: 7 })
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'site-keys',
        overrideAccess: true,
        where: { keyHash: { equals: await hashSiteKey(key) } },
      }),
    )
  })

  it('reads isAggregate from a populated tenant and caches the lookup', async () => {
    const { key } = await generateSiteKey()
    const { find, req } = requestFor({
      docs: [{ id: 2, tenant: { id: 8, isAggregate: true } }],
      key,
    })

    expect(await resolveSiteKey(req)).toEqual({ id: 2, isAggregate: true, tenantID: 8 })
    expect(await resolveSiteKey(req)).toEqual({ id: 2, isAggregate: true, tenantID: 8 })
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('returns null for an unknown key', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({ docs: [], key })

    expect(await resolveSiteKey(req)).toBeNull()
  })
})

describe('site key access override @S-011', () => {
  it('leaves requests without a key unchanged', async () => {
    const { find, req } = requestFor({})

    expect(await override(args(req, 'read', 'media', false))).toBe(false)
    expect(await override(args(req, 'read', 'media', true))).toBe(true)
    expect(find).not.toHaveBeenCalled()
  })

  it('never overrides a logged-in user session', async () => {
    const { key } = await generateSiteKey()
    const { find, req } = requestFor({
      docs: [{ id: 1, tenant: 7 }],
      key,
      user: { id: 1 },
    })
    const sessionResult = { tenant: { equals: 99 } }

    expect(await override(args(req, 'read', 'media', sessionResult))).toEqual(sessionResult)
    expect(find).not.toHaveBeenCalled()
  })

  it('scopes an allowed read to the key tenant', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({ docs: [{ id: 1, tenant: 7 }], key })

    expect(await override(args(req, 'read'))).toEqual({ tenant: { equals: 7 } })
  })

  it('keeps tenants isolated from each other', async () => {
    const keyA = await generateSiteKey()
    const keyB = await generateSiteKey()
    const a = requestFor({ docs: [{ id: 1, tenant: 7 }], key: keyA.key })
    const b = requestFor({ docs: [{ id: 2, tenant: 8 }], key: keyB.key })

    expect(await override(args(a.req, 'read'))).toEqual({ tenant: { equals: 7 } })
    expect(await override(args(b.req, 'read'))).toEqual({ tenant: { equals: 8 } })
  })

  it('rejects an unknown key instead of falling back to public access', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({ docs: [], key })

    expect(await override(args(req, 'read', 'media', true))).toBe(false)
  })

  it('lets an aggregate key read published docs from tenants A and B', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({
      docs: [{ id: 1, tenant: { id: 7, isAggregate: true } }],
      key,
    })

    // No tenant constraint at all: tenant A and tenant B documents both match.
    expect(await override(args(req, 'read'))).toBe(true)
  })

  it('scopes an aggregate key to published docs when drafts are enabled', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({
      docs: [{ id: 1, tenant: { id: 7, isAggregate: true } }],
      drafts: true,
      key,
    })

    expect(await override(args(req, 'read'))).toEqual({ _status: { equals: 'published' } })
  })

  it('scopes a tenant key to its tenant and hides drafts', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({ docs: [{ id: 1, tenant: 7 }], drafts: true, key })

    expect(await override(args(req, 'read'))).toEqual({
      and: [{ tenant: { equals: 7 } }, { _status: { equals: 'published' } }],
    })
  })

  it('rejects writes even with an aggregate key', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({
      docs: [{ id: 1, tenant: { id: 7, isAggregate: true } }],
      key,
    })

    expect(await override(args(req, 'create'))).toBe(false)
  })

  it('rejects writes even with a valid key', async () => {
    const { key } = await generateSiteKey()
    const { req } = requestFor({ docs: [{ id: 1, tenant: 7 }], key })

    expect(await override(args(req, 'create'))).toBe(false)
  })

  it('denies keyed reads for collections outside the allowlist', async () => {
    const { key } = await generateSiteKey()
    const { find, req } = requestFor({ docs: [{ id: 1, tenant: 7 }], key })

    expect(await override(args(req, 'read', 'users', true))).toBe(false)
    expect(find).not.toHaveBeenCalled()
  })
})
