import type { CollectionConfig } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { hashSiteKey } from '../site-keys'
import { taxonomyCollections } from '../taxonomies'
import { bootTestPayload, type TestHarness } from '../test'
import { locationsCollection } from './locations'
import { organisationsCollection } from './organisations'

/**
 * PJ-38 against a real database: what a site key can read of the organisations, and what the
 * duplicate flag stops. The rule is a query, so only a database proves it filters (a missing
 * boolean, the other tenant, the per-tenant approval setting).
 */

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: () => false, read: () => false },
  fields: [
    { name: 'label', type: 'text', required: true },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

describe('public organisations for a site key (PJ-38)', () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await bootTestPayload({
      collections: [
        organisationsCollection({ mediaSlug: null }),
        locationsCollection({ requireTenant: true }),
        ...taxonomyCollections({ tenantScoped: true }),
      ],
      globalCollections: [SiteKeys],
      tenantFields: [{ name: 'organisationPagesNeedApproval', type: 'checkbox', defaultValue: true }],
    })

    for (const [label, tenant] of [
      ['a', harness.tenantA.id],
      ['b', harness.tenantB.id],
    ] as const) {
      await harness.payload.create({
        collection: 'site-keys' as never,
        data: { keyHash: await hashSiteKey(`sk_${label}`), label, tenant } as never,
        overrideAccess: true,
      })
    }
  })

  afterEach(async () => {
    await harness?.destroy()
  })

  const make = async (
    tenant: number,
    slug: string,
    flags: { approved?: boolean; pageEnabled?: boolean; possibleDuplicate?: boolean },
  ) =>
    harness.payload.create({
      collection: 'organisations',
      data: { name: slug, slug, tenant, ...flags } as never,
      overrideAccess: true,
    })

  const slugsFor = async (key: string): Promise<string[]> => {
    const result = await harness.payload.find({
      collection: 'organisations',
      limit: 100,
      overrideAccess: false,
      req: { headers: new Headers({ 'x-site-key': key }) } as never,
      sort: 'slug',
    })
    return result.docs.map((doc) => doc.slug as string)
  }

  const setApproval = (tenant: number, value: boolean) =>
    harness.payload.update({
      collection: 'tenants',
      data: { organisationPagesNeedApproval: value } as never,
      id: tenant,
      overrideAccess: true,
    })

  it('shows only approved organisations whose page is on, never a private one @S-220', async () => {
    const a = harness.tenantA.id
    await make(a, 'public-co', { approved: true, pageEnabled: true })
    await make(a, 'private-co', { approved: true, pageEnabled: false })
    await make(a, 'waiting-co', { approved: false, pageEnabled: true })
    await make(a, 'default-co', {})

    expect(await slugsFor('sk_a')).toEqual(['public-co'])
  })

  it('hides a possible duplicate, and the guard keeps a public page from being flagged @S-221', async () => {
    const a = harness.tenantA.id
    const org = (await make(a, 'twin-co', { approved: true, pageEnabled: true })) as { id: number }
    expect(await slugsFor('sk_a')).toEqual(['twin-co'])

    await expect(
      harness.payload.update({
        collection: 'organisations',
        data: { possibleDuplicate: true } as never,
        id: org.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow()

    await harness.payload.update({
      collection: 'organisations',
      data: { pageEnabled: false, possibleDuplicate: true } as never,
      id: org.id,
      overrideAccess: true,
    })
    expect(await slugsFor('sk_a')).toEqual([])

    await harness.payload.update({
      collection: 'organisations',
      data: { pageEnabled: true, possibleDuplicate: false } as never,
      id: org.id,
      overrideAccess: true,
    })
    expect(await slugsFor('sk_a')).toEqual(['twin-co'])
  })

  it('refuses to create a flagged organisation with a public page @S-221', async () => {
    await expect(
      make(harness.tenantA.id, 'flagged-co', { pageEnabled: true, possibleDuplicate: true }),
    ).rejects.toThrow()
  })

  it('drops the approval step when the tenant turns the setting off, for that tenant only @S-220', async () => {
    const a = harness.tenantA.id
    const b = harness.tenantB.id
    await make(a, 'owner-published-a', { approved: false, pageEnabled: true })
    await make(b, 'owner-published-b', { approved: false, pageEnabled: true })

    expect(await slugsFor('sk_a')).toEqual([])
    expect(await slugsFor('sk_b')).toEqual([])

    await setApproval(a, false)

    expect(await slugsFor('sk_a')).toEqual(['owner-published-a'])
    expect(await slugsFor('sk_b')).toEqual([])
  })

  it('still hides a possible duplicate when approval is off @S-221', async () => {
    const a = harness.tenantA.id
    await setApproval(a, false)
    await make(a, 'dup-co', { pageEnabled: false, possibleDuplicate: true })
    expect(await slugsFor('sk_a')).toEqual([])
  })

  it('never shows one tenant’s organisation to another tenant’s key @S-220', async () => {
    await make(harness.tenantA.id, 'only-a', { approved: true, pageEnabled: true })
    await make(harness.tenantB.id, 'only-b', { approved: true, pageEnabled: true })

    expect(await slugsFor('sk_a')).toEqual(['only-a'])
    expect(await slugsFor('sk_b')).toEqual(['only-b'])
  })

  it('reads nothing without a key, or with an unknown one @S-220', async () => {
    await make(harness.tenantA.id, 'public-co', { approved: true, pageEnabled: true })

    await expect(slugsFor('sk_unknown')).rejects.toThrow(/not allowed/i)
    await expect(
      harness.payload.find({
        collection: 'organisations',
        overrideAccess: false,
        req: { headers: new Headers() } as never,
      }),
    ).rejects.toThrow(/not allowed/i)
  })
})
