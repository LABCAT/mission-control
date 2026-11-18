import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseVanuatuLocations, seedVanuatuLocations } from '../seed/vanuatu'
import { bootTestPayload, type TestHarness } from '../test'
import { locationsCollection } from './locations'

type Stored = {
  id: number | string
  kind: string
  parent: null | number | string
  slug: string
  tenant: number | string
}

/** Payload's top-level message is generic, so assert on the per-field messages. */
const fieldMessages = (error: unknown): string =>
  (
    (error as { data?: { errors?: { message: string }[] } }).data?.errors ?? []
  )
    .map((fieldError) => fieldError.message)
    .join(' | ')

describe('locations tree', () => {
  let harness: TestHarness
  const extraTenantIds: (number | string)[] = []

  const create = async (data: Record<string, unknown>, tenantID: number | string, user?: unknown) =>
    (await harness.payload.create({
      collection: 'locations',
      data: { ...data, tenant: tenantID } as never,
      user: (user ?? harness.tenantAdminA) as never,
    })) as unknown as Stored

  const readBack = async (id: number | string): Promise<Stored> =>
    (await harness.payload.findByID({
      collection: 'locations',
      depth: 0,
      id,
      overrideAccess: true,
    })) as unknown as Stored

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [locationsCollection({ requireTenant: true })],
    })
  })

  afterAll(async () => {
    for (const id of extraTenantIds) {
      await harness.payload.delete({
        collection: 'locations',
        overrideAccess: true,
        where: { tenant: { equals: id } },
      })
      await harness.payload.delete({ collection: 'tenants', id, overrideAccess: true })
    }
    if (harness) await harness.destroy()
  })

  it('accepts region → island → town and keeps the parent link', async () => {
    const region = await create({ kind: 'region', name: 'Shefa', slug: 'shefa' }, harness.tenantA.id)
    const island = await create(
      { kind: 'island', name: 'Efate', parent: region.id, slug: 'efate' },
      harness.tenantA.id,
    )
    const town = await create(
      { kind: 'town', name: 'Port Vila', parent: island.id, slug: 'port-vila' },
      harness.tenantA.id,
    )

    expect((await readBack(island.id)).parent).toBe(region.id)
    expect((await readBack(town.id)).parent).toBe(island.id)
  })

  it('rejects a town under a town so the tree stays three levels', async () => {
    const region = await create({ kind: 'region', name: 'Tafea', slug: 'tafea' }, harness.tenantA.id)
    const island = await create(
      { kind: 'island', name: 'Tanna', parent: region.id, slug: 'tanna' },
      harness.tenantA.id,
    )
    const town = await create(
      { kind: 'town', name: 'Lenakel', parent: island.id, slug: 'lenakel' },
      harness.tenantA.id,
    )

    await expect(
      create({ kind: 'town', name: 'Isangel', parent: town.id, slug: 'isangel' }, harness.tenantA.id),
    ).rejects.toThrow()
  })

  it('rejects a region with a parent and an island under a town', async () => {
    const region = await create(
      { kind: 'region', name: 'Malampa', slug: 'malampa' },
      harness.tenantA.id,
    )
    const island = await create(
      { kind: 'island', name: 'Malekula', parent: region.id, slug: 'malekula' },
      harness.tenantA.id,
    )
    const town = await create(
      { kind: 'town', name: 'Lakatoro', parent: island.id, slug: 'lakatoro' },
      harness.tenantA.id,
    )

    await expect(
      create({ kind: 'region', name: 'Sanma', parent: region.id, slug: 'sanma' }, harness.tenantA.id),
    ).rejects.toThrow()

    await expect(
      create({ kind: 'island', name: 'Ambae', parent: town.id, slug: 'ambae' }, harness.tenantA.id),
    ).rejects.toThrow()
  })

  it('rejects a parent that belongs to another tenant', async () => {
    const foreign = await create(
      { kind: 'region', name: 'Torba', slug: 'torba' },
      harness.tenantB.id,
      harness.tenantAdminB,
    )

    const error = await create(
      { kind: 'island', name: 'Gaua', parent: foreign.id, slug: 'gaua' },
      harness.tenantA.id,
    ).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(fieldMessages(error)).toMatch(/another tenant/)
  })

  it('allows one slug per tenant but not twice inside a tenant', async () => {
    await create({ kind: 'town', name: 'Luganville', slug: 'luganville' }, harness.tenantA.id)

    const error = await create(
      { kind: 'town', name: 'Luganville', slug: 'luganville' },
      harness.tenantA.id,
    ).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(fieldMessages(error)).toMatch(/already used/)

    await expect(
      create(
        { kind: 'town', name: 'Luganville', slug: 'luganville' },
        harness.tenantB.id,
        harness.tenantAdminB,
      ),
    ).resolves.toMatchObject({ slug: 'luganville' })
  })

  it('rejects a location with no tenant, so the tree stays tenant-scoped', async () => {
    const error = await harness.payload
      .create({
        collection: 'locations',
        data: { kind: 'region', name: 'No tenant', slug: 'no-tenant' } as never,
        overrideAccess: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toBe('A location must belong to a tenant')
  })

  it('rejects a tenantless child even below a real parent', async () => {
    const parent = await create(
      { kind: 'region', name: 'Penama', slug: 'penama' },
      harness.tenantA.id,
    )

    const error = await harness.payload
      .create({
        collection: 'locations',
        data: { kind: 'island', name: 'Ambae', parent: parent.id, slug: 'ambae' } as never,
        overrideAccess: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toBe('A location must belong to a tenant')
  })

  it('rejects a slug that is not already a slug', async () => {
    const error = await create(
      { kind: 'region', name: 'Port Vila', slug: 'Port Vila' },
      harness.tenantA.id,
    ).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(fieldMessages(error)).toMatch(/lowercase letters/)
  })

  it('shows a tenant admin only their own tenant’s locations', async () => {
    await create(
      { kind: 'region', name: 'Shefa', slug: 'shefa' },
      harness.tenantB.id,
      harness.tenantAdminB,
    )

    const { docs } = await harness.payload.find({
      collection: 'locations',
      depth: 0,
      pagination: false,
      user: harness.tenantAdminB as never,
      where: { slug: { equals: 'shefa' } },
    })

    expect(docs.map((doc) => (doc as unknown as Stored).tenant)).toEqual([harness.tenantB.id])
  })

  describe('seed', () => {
    const expected = parseVanuatuLocations()
    let seedTenantID: number

    beforeAll(async () => {
      const tenant = (await harness.payload.create({
        collection: 'tenants',
        data: { name: 'Seed tenant', slug: `seed-${Date.now().toString(36)}` },
        overrideAccess: true,
      })) as { id: number }

      seedTenantID = tenant.id
      extraTenantIds.push(seedTenantID)
    })

    it('creates the whole tree, then updates it instead of duplicating it', async () => {
      const first = await seedVanuatuLocations({ payload: harness.payload, tenant: seedTenantID })
      expect(first).toEqual({ created: expected.length, updated: 0 })

      const second = await seedVanuatuLocations({ payload: harness.payload, tenant: seedTenantID })
      expect(second).toEqual({ created: 0, updated: expected.length })

      const { docs } = await harness.payload.find({
        collection: 'locations',
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: seedTenantID } },
      })

      expect(docs).toHaveLength(expected.length)
    })

    it('links every seeded location to a parent of the expected kind', async () => {
      const { docs } = await harness.payload.find({
        collection: 'locations',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        where: { tenant: { equals: seedTenantID } },
      })

      const byID = new Map(docs.map((doc) => [String(doc.id), doc as unknown as Stored]))

      for (const doc of docs) {
        const stored = doc as unknown as Stored

        // Only towns are leaves; islands and regions are roots in the legacy picker's shape.
        if (stored.kind !== 'town') {
          expect(stored.parent, `${stored.slug} should be a root`).toBeNull()
          continue
        }

        const parent = byID.get(String(stored.parent))
        expect(parent, `${stored.slug} has no parent`).toBeDefined()
        expect(['island', 'region']).toContain(parent?.kind)
      }

      const roots = docs
        .filter((doc) => (doc as unknown as Stored).kind === 'region')
        .map((doc) => (doc as unknown as Stored).slug)
      expect(roots).toHaveLength(2)
      expect(roots).toEqual(expect.arrayContaining(['other', 'overseas']))
    })

    it('seeds into one tenant only', async () => {
      const { totalDocs } = await harness.payload.count({
        collection: 'locations',
        overrideAccess: true,
        // `longana` only exists in the seed, so it proves the seed stayed in one tenant.
        where: { and: [{ tenant: { not_equals: seedTenantID } }, { slug: { equals: 'longana' } }] },
      })

      expect(totalDocs).toBe(0)
    })
  })
})
