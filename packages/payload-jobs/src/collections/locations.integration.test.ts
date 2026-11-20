import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { tenantLocationFields, tenantLocationSettings, type TenantLocationSource } from '../location-settings'
import { parseVanuatuLocations, seedVanuatuLocations } from '../seed/vanuatu'
import { bootTestPayload, type TestHarness } from '../test'
import { locationsCollection } from './locations'

type Stored = {
  depth: null | number
  id: number | string
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
      collections: [
        locationsCollection({
          limits: async ({ data, req }) => {
            const ref = data.tenant
            const tenantID = ref && typeof ref === 'object' ? ref.id : ref
            if (tenantID === null || tenantID === undefined) return null

            const tenant = await req.payload.findByID({
              collection: 'tenants',
              depth: 0,
              id: tenantID,
              overrideAccess: true,
              req,
            })

            return tenantLocationSettings(tenant as TenantLocationSource)
          },
          requireTenant: true,
        }),
      ],
      tenantData: (which) =>
        which === 'A'
          ? { locationLevels: [{ label: 'Island' }, { label: 'Town' }], locationMaxDepth: 1 }
          : {
              locationLevels: [{ label: 'Region' }, { label: 'City' }, { label: 'Suburb' }],
              locationMaxDepth: 2,
            },
      tenantFields: tenantLocationFields(),
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

  it('takes any depth and computes it from the parent chain', async () => {
    const region = await create({ name: 'Shefa', slug: 'shefa' }, harness.tenantB.id, harness.tenantAdminB)
    const city = await create(
      { name: 'Efate', parent: region.id, slug: 'efate' },
      harness.tenantB.id,
      harness.tenantAdminB,
    )
    const suburb = await create(
      { name: 'Port Vila', parent: city.id, slug: 'port-vila' },
      harness.tenantB.id,
      harness.tenantAdminB,
    )

    expect((await readBack(region.id)).depth).toBe(0)
    expect(await readBack(city.id)).toMatchObject({ depth: 1, parent: region.id })
    expect(await readBack(suburb.id)).toMatchObject({ depth: 2, parent: city.id })
  })

  it('names the levels and caps the depth per tenant', async () => {
    const tenantA = (await harness.payload.findByID({
      collection: 'tenants',
      depth: 0,
      id: harness.tenantA.id,
      overrideAccess: true,
    })) as TenantLocationSource
    const tenantB = (await harness.payload.findByID({
      collection: 'tenants',
      depth: 0,
      id: harness.tenantB.id,
      overrideAccess: true,
    })) as TenantLocationSource

    expect(tenantLocationSettings(tenantA)).toEqual({ levels: ['Island', 'Town'], maxDepth: 1 })
    expect(tenantLocationSettings(tenantB)).toEqual({
      levels: ['Region', 'City', 'Suburb'],
      maxDepth: 2,
    })

    // Tenant A names Island → Town, so a third level is refused with those names.
    const island = await create({ name: 'Tafea', slug: 'tafea' }, harness.tenantA.id)
    const town = await create(
      { name: 'Tanna', parent: island.id, slug: 'tanna' },
      harness.tenantA.id,
    )

    const error = await create(
      { name: 'Lenakel', parent: town.id, slug: 'lenakel' },
      harness.tenantA.id,
    ).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(fieldMessages(error)).toBe('This tenant allows at most 2 location levels (Island → Town)')
  })

  it('rejects a parent that belongs to another tenant', async () => {
    const foreign = await create(
      { name: 'Torba', slug: 'torba' },
      harness.tenantB.id,
      harness.tenantAdminB,
    )

    const error = await create({ name: 'Gaua', parent: foreign.id, slug: 'gaua' }, harness.tenantA.id).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(fieldMessages(error)).toMatch(/another tenant/)
  })

  it('rejects moving a location under one of its own descendants', async () => {
    const root = await create({ name: 'Malampa', slug: 'malampa' }, harness.tenantA.id)
    const child = await create(
      { name: 'Malekula', parent: root.id, slug: 'malekula' },
      harness.tenantA.id,
    )

    const error = await harness.payload
      .update({
        collection: 'locations',
        data: { parent: child.id } as never,
        id: root.id,
        user: harness.tenantAdminA as never,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toBe('A location cannot sit under one of its own descendants')
  })

  it('rechecks the parent when an update never submits it', async () => {
    const root = await create({ name: 'Sanma', slug: 'sanma' }, harness.tenantA.id)
    const child = await create(
      { name: 'Espiritu Santo', parent: root.id, slug: 'espiritu-santo' },
      harness.tenantA.id,
    )

    // Moving the child to tenant B leaves its stored parent in tenant A. The request never
    // mentions `parent`, so only the collection hook can catch it.
    const error = await harness.payload
      .update({
        collection: 'locations',
        data: { tenant: harness.tenantB.id } as never,
        id: child.id,
        overrideAccess: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toMatch(/another tenant/)
  })

  it('allows one slug per tenant but not twice inside a tenant', async () => {
    await create({ name: 'Luganville', slug: 'luganville' }, harness.tenantA.id)

    const error = await create({ name: 'Luganville', slug: 'luganville' }, harness.tenantA.id).then(
      () => null,
      (reason: unknown) => reason,
    )
    expect(fieldMessages(error)).toMatch(/already used/)

    await expect(
      create(
        { name: 'Luganville', slug: 'luganville' },
        harness.tenantB.id,
        harness.tenantAdminB,
      ),
    ).resolves.toMatchObject({ slug: 'luganville' })
  })

  it('rejects a location with no tenant, so the tree stays tenant-scoped', async () => {
    const error = await harness.payload
      .create({
        collection: 'locations',
        data: { name: 'No tenant', slug: 'no-tenant' } as never,
        overrideAccess: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toBe('A location must belong to a tenant')
  })

  it('rejects a tenantless child even below a real parent', async () => {
    const parent = await create({ name: 'Penama', slug: 'penama' }, harness.tenantA.id)

    const error = await harness.payload
      .create({
        collection: 'locations',
        data: { name: 'Ambae', parent: parent.id, slug: 'ambae' } as never,
        overrideAccess: true,
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      )

    expect(fieldMessages(error)).toBe('A location must belong to a tenant')
  })

  it('rejects a slug that is not already a slug', async () => {
    const error = await create({ name: 'Port Vila', slug: 'Port Vila' }, harness.tenantA.id).then(
      () => null,
      (reason: unknown) => reason,
    )

    expect(fieldMessages(error)).toMatch(/lowercase letters/)
  })

  it('shows a tenant admin only their own tenant’s locations', async () => {
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

    it('keeps the legacy picker’s two levels: island roots and their towns', async () => {
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

        // Only towns are leaves: the seed writes two levels.
        if (stored.depth === 1) {
          const parent = byID.get(String(stored.parent))
          expect(parent, `${stored.slug} has no parent`).toBeDefined()
          expect(parent?.depth).toBe(0)
          continue
        }

        expect(stored.depth, `${stored.slug} should be a root`).toBe(0)
        expect(stored.parent).toBeNull()
      }

      const roots = docs.filter((doc) => (doc as unknown as Stored).depth === 0)
      const rootSlugs = roots.map((doc) => (doc as unknown as Stored).slug)
      expect(roots).toHaveLength(expected.filter((seed) => seed.parentSlug === null).length)
      expect(rootSlugs).toEqual(expect.arrayContaining(['other', 'overseas']))
      expect(docs.every((doc) => ((doc as unknown as Stored).depth ?? -1) <= 1)).toBe(true)
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
