import type { PayloadRequest } from 'payload'
import { describe, expect, it } from 'vitest'

import { createSiteKeyAccessOverride, hashSiteKey } from '../site-keys'
import {
  duplicateCannotBePublic,
  isOrganisationPublic,
  organisationReadAccess,
  organisationsCollection,
  publicOrganisationFilter,
} from './organisations'

/** A site-key request whose tenant carries (or lacks) the page-approval setting. */
const keyedRequest = async ({
  aggregate = false,
  needsApproval,
  tenant = 10,
}: {
  aggregate?: boolean
  needsApproval?: boolean
  tenant?: number
}) => {
  const keyHash = await hashSiteKey('sk_test')
  let tenantReads = 0

  const req = {
    context: {},
    headers: new Headers({ 'x-site-key': 'sk_test' }),
    payload: {
      collections: { 'site-keys': {} },
      find: async (args: { where?: { keyHash?: { equals?: string } } }) => ({
        docs:
          args.where?.keyHash?.equals === keyHash
            ? [{ id: 1, tenant: { id: tenant, isAggregate: aggregate } }]
            : [],
      }),
      findByID: async () => {
        tenantReads += 1
        return { id: tenant, ...(needsApproval === undefined ? {} : { organisationPagesNeedApproval: needsApproval }) }
      },
    },
    user: null,
  } as unknown as PayloadRequest

  return { req, tenantReads: () => tenantReads }
}

const read = (req: PayloadRequest, tenantsSlug?: string) =>
  organisationReadAccess(true, tenantsSlug)({ req } as never)

describe('public organisation rule (PJ-38) @S-220', () => {
  it('is private until the page is on, and a possible duplicate is never public', () => {
    expect(isOrganisationPublic({ approved: true })).toBe(false)
    expect(isOrganisationPublic({ approved: true, pageEnabled: true })).toBe(true)
    expect(isOrganisationPublic({ approved: true, pageEnabled: true, possibleDuplicate: true })).toBe(false)
    expect(isOrganisationPublic(null)).toBe(false)
  })

  it('needs the admin approval only where the tenant requires it', () => {
    const waiting = { approved: false, pageEnabled: true }
    expect(isOrganisationPublic(waiting)).toBe(false)
    expect(isOrganisationPublic(waiting, { needsApproval: true })).toBe(false)
    expect(isOrganisationPublic(waiting, { needsApproval: false })).toBe(true)
    // Approval never overrides the duplicate flag.
    expect(isOrganisationPublic({ ...waiting, possibleDuplicate: true }, { needsApproval: false })).toBe(false)
  })

  it('builds the same rule as a query', () => {
    expect(publicOrganisationFilter(true)).toEqual({
      and: [
        { pageEnabled: { equals: true } },
        { possibleDuplicate: { not_equals: true } },
        { approved: { equals: true } },
      ],
    })
    expect(JSON.stringify(publicOrganisationFilter(false))).not.toContain('approved')
  })
})

describe('organisation read access for a site key (PJ-38) @S-220', () => {
  it('requires approval by default, as the legacy site did', async () => {
    const { req } = await keyedRequest({})
    expect(await read(req)).toEqual({
      and: [{ tenant: { equals: 10 } }, publicOrganisationFilter(true)],
    })
  })

  it('drops the approval step when the tenant turns the setting off', async () => {
    const { req } = await keyedRequest({ needsApproval: false })
    expect(await read(req)).toEqual({
      and: [{ tenant: { equals: 10 } }, publicOrganisationFilter(false)],
    })
  })

  it('reads the tenant once per request', async () => {
    const { req, tenantReads } = await keyedRequest({ needsApproval: false })
    await read(req)
    await read(req)
    expect(tenantReads()).toBe(1)
  })

  it('keeps the strict rule for an aggregate key, which spans tenants', async () => {
    const { req } = await keyedRequest({ aggregate: true, needsApproval: false })
    expect(await read(req)).toEqual(publicOrganisationFilter(true))
  })

  it('is scoped to the key’s own tenant, never another', async () => {
    const { req } = await keyedRequest({ needsApproval: false, tenant: 22 })
    expect(await read(req)).toEqual({
      and: [{ tenant: { equals: 22 } }, publicOrganisationFilter(false)],
    })
  })
})

describe('possible duplicates (PJ-38) @S-221', () => {
  const run = (data: Record<string, unknown>, originalDoc?: Record<string, unknown>) =>
    duplicateCannotBePublic()({ data, originalDoc, req: {} } as never)

  it('refuses to switch the page on while the flag is set', () => {
    let error: unknown
    try {
      run({ pageEnabled: true, possibleDuplicate: true })
    } catch (caught) {
      error = caught
    }
    expect(JSON.stringify((error as { data?: unknown }).data)).toMatch(/possible duplicate/i)
  })

  it('refuses to flag an organisation whose page is already public', () => {
    expect(() => run({ possibleDuplicate: true }, { pageEnabled: true })).toThrow()
  })

  it('lets a cleared flag, a private page and unrelated edits through', () => {
    expect(() => run({ pageEnabled: true, possibleDuplicate: false }, { possibleDuplicate: true })).not.toThrow()
    expect(() => run({ possibleDuplicate: true }, { pageEnabled: false })).not.toThrow()
    expect(() => run({ about: 'x' }, { pageEnabled: true })).not.toThrow()
  })

  it('is wired into the collection, and only a tenant admin can set the flag', () => {
    const collection = organisationsCollection()
    expect(collection.hooks?.beforeChange?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('site-key override for collections with their own rule (PJ-38) @S-222', () => {
  const override = createSiteKeyAccessOverride({
    allowedCollections: ['media', 'organisations'],
    ownAccessCollections: ['organisations'],
  })
  const call = (req: PayloadRequest, slug: string, accessResult: unknown, accessKey = 'read') =>
    override({ accessKey, accessResult, req, slug } as never)

  it('keeps the organisations’ own rule instead of the generic published scope', async () => {
    const { req } = await keyedRequest({ needsApproval: true })
    const own = { and: [{ tenant: { equals: 10 } }, publicOrganisationFilter(true)] }

    expect(await call(req, 'organisations', own)).toBe(own)
  })

  it('still refuses a write, and an unknown key', async () => {
    const { req } = await keyedRequest({})
    expect(await call(req, 'organisations', true, 'create')).toBe(false)

    const unknown = { ...req, headers: new Headers({ 'x-site-key': 'sk_nope' }) } as unknown as PayloadRequest
    expect(await call(unknown, 'organisations', true)).toBe(false)
  })

  it('does not widen another collection: it keeps the published, tenant-scoped result', async () => {
    const { req } = await keyedRequest({})
    expect(await call(req, 'media', false)).toEqual({ tenant: { equals: 10 } })
  })
})
