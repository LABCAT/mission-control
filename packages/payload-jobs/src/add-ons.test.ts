import type { CollectionConfig, Field, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection, ADD_ONS_SLUG } from './add-ons'
import { AddOnSeedError, addOnSeedProblems, seedAddOns, type AddOnSeed } from './add-ons-seed'
import { expireJobPlacementsTask, jobPlacementsField, type JobPlacement } from './placements'
import { planCollection, PLANS_SLUG, withPlanRestrictionGuards } from './plans'
import { quote, type QuotableAddOn, type QuotablePlan } from './pricing'
import { hashSiteKey } from './site-keys'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, tenantIsolation, type TestHarness, type TestTenant } from './test'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'isAggregate', type: 'checkbox', defaultValue: false },
]
const tenantData = (which: 'A' | 'B') => ({ currency: which === 'A' ? 'VUV' : 'NZD' })

/** Just enough of the cms `site-keys` collection for `resolveSiteKey`. */
const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { read: () => false },
  fields: [
    { name: 'keyHash', type: 'text', index: true },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants' },
  ],
  versions: false,
}

/** A stand-in for the PJ-19 jobs collection: just the placements. */
const Jobs: CollectionConfig = {
  slug: 'jobs',
  fields: [{ name: 'title', type: 'text' }, jobPlacementsField()],
  versions: false,
}

const catalogCollections = (): CollectionConfig[] => [
  addOnCollection(),
  planCollection(),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

const addOnData = (overrides: Record<string, unknown> = {}) => ({
  durationDays: 30,
  key: 'enhanced',
  name: 'Enhanced',
  placement: 'featured-in-listings',
  price: 2000,
  ...overrides,
})

const planData = (overrides: Record<string, unknown> = {}) => ({
  durationDays: 30,
  jobCredits: 1,
  key: 'regular-listing',
  name: 'Regular listing',
  price: 5000,
  ...overrides,
})

tenantIsolation({
  boot: { tenantData, tenantFields },
  collection: addOnCollection(),
  createData: () => addOnData(),
  extraCollections: [planCollection(), ...taxonomyCollections({ tenantScoped: true })],
})

/** The local API fills in the rest of a partial request, keeping these headers. */
const anonymousReq = async (key?: string): Promise<PayloadRequest> =>
  ({ headers: new Headers(key ? { 'x-site-key': key } : {}) }) as PayloadRequest

/** Ascending numeric order. Sorts a copy; `toSorted` is ES2023, past this package's lib. */
// oxlint-disable-next-line unicorn/no-array-sort
const ascending = (ids: number[]): number[] => [...ids].sort((a, b) => a - b)

type User = { collection: 'users'; id: number; role: 'user'; tenants: { role: string; tenant: number }[] }

describe('add-ons', () => {
  let harness: TestHarness
  const extraUserIDs: number[] = []
  const extraTenantIDs: number[] = []
  const users: Record<'editorA' | 'employerA' | 'seekerA', User> = {} as never
  const docs: Record<'enhancedA' | 'retiredA' | 'enhancedB', { id: number }> = {} as never
  const siteKeyA = 'sk_test_add_ons_a'

  const makeUser = async (label: string, tenants: User['tenants']): Promise<User> => {
    const doc = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
      },
      overrideAccess: true,
    })) as { id: number }
    extraUserIDs.push(doc.id)
    return { collection: 'users', id: doc.id, role: 'user', tenants }
  }

  const makeTenant = async (data: Record<string, unknown>): Promise<TestTenant> => {
    const doc = (await harness.payload.create({
      collection: 'tenants',
      data: { slug: `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data },
      overrideAccess: true,
    })) as TestTenant
    extraTenantIDs.push(doc.id)
    return doc
  }

  const createAddOn = (tenant: number, data: Record<string, unknown> = {}) =>
    harness.payload.create({
      collection: ADD_ONS_SLUG,
      data: { ...addOnData(data), tenant },
      overrideAccess: true,
    }) as Promise<{ id: number }>

  const visible = async (args: { req?: PayloadRequest; user?: unknown }): Promise<number[]> => {
    try {
      const { docs: found } = await harness.payload.find({
        collection: ADD_ONS_SLUG,
        depth: 0,
        limit: 100,
        overrideAccess: false,
        req: args.req,
        user: args.user as never,
        where: { tenant: { in: [harness.tenantA.id, harness.tenantB.id] } },
      })
      return ascending(found.map((doc) => Number(doc.id)))
    } catch (error) {
      if ((error as { status?: number }).status === 403) return []
      throw error
    }
  }

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: catalogCollections(),
      globalCollections: [SiteKeys],
      tenantData,
      tenantFields,
    })

    const { tenantA, tenantB } = harness
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: tenantA.id }])
    users.employerA = await makeUser('employer-a', [{ role: 'employer', tenant: tenantA.id }])
    users.seekerA = await makeUser('seeker-a', [{ role: 'seeker', tenant: tenantA.id }])

    docs.enhancedA = await createAddOn(tenantA.id)
    docs.retiredA = await createAddOn(tenantA.id, { active: false, key: 'retired', name: 'Retired' })
    docs.enhancedB = await createAddOn(tenantB.id)

    await harness.payload.create({
      collection: 'site-keys',
      data: { keyHash: await hashSiteKey(siteKeyA), tenant: tenantA.id },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (!harness) return
    const { payload } = harness
    await payload.delete({ collection: 'site-keys', overrideAccess: true, where: { id: { exists: true } } })
    await payload.delete({ collection: PLANS_SLUG, overrideAccess: true, where: { id: { exists: true } } })
    // Grants first, so the delete guard doesn't stop the clean-up.
    await payload.update({
      collection: ADD_ONS_SLUG,
      data: { grants: [] },
      overrideAccess: true,
      where: { id: { exists: true } },
    })
    await payload.delete({ collection: ADD_ONS_SLUG, overrideAccess: true, where: { id: { exists: true } } })
    if (extraUserIDs.length) {
      await payload.delete({ collection: 'users', overrideAccess: true, where: { id: { in: extraUserIDs } } })
    }
    if (extraTenantIDs.length) {
      await payload.delete({ collection: 'tenants', overrideAccess: true, where: { id: { in: extraTenantIDs } } })
    }
    await harness.destroy()
  })

  describe('access', () => {
    it('shows staff every add-on in their tenant, inactive ones included', async () => {
      const expected = ascending([docs.enhancedA.id, docs.retiredA.id])
      expect(await visible({ user: harness.tenantAdminA })).toEqual(expected)
      expect(await visible({ user: users.editorA })).toEqual(expected)
    })

    it('shows employers and their site key only the add-ons on sale', async () => {
      expect(await visible({ user: users.employerA })).toEqual([docs.enhancedA.id])
      expect(await visible({ req: await anonymousReq(siteKeyA) })).toEqual([docs.enhancedA.id])
    })

    it('shows seekers and keyless requests nothing', async () => {
      expect(await visible({ user: users.seekerA })).toEqual([])
      expect(await visible({ req: await anonymousReq() })).toEqual([])
      expect(await visible({ req: await anonymousReq('sk_unknown') })).toEqual([])
    })

    it('lets editors write, but not employers; and only super admins delete', async () => {
      const created = (await harness.payload.create({
        collection: ADD_ONS_SLUG,
        data: { ...addOnData({ key: 'editor-made' }), tenant: harness.tenantA.id },
        overrideAccess: false,
        user: users.editorA as never,
      })) as { currency: string; id: number }
      expect(created.currency).toBe('VUV')

      await expect(
        harness.payload.update({
          collection: ADD_ONS_SLUG,
          data: { price: 1 },
          id: created.id,
          overrideAccess: false,
          user: users.employerA as never,
        }),
      ).rejects.toThrow()
      await expect(
        harness.payload.delete({
          collection: ADD_ONS_SLUG,
          id: created.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('never lets an add-on lose its tenant', async () => {
      await expect(
        harness.payload.update({
          collection: ADD_ONS_SLUG,
          data: { tenant: null },
          id: docs.enhancedA.id,
          overrideAccess: false,
          user: users.editorA as never,
        }),
      ).rejects.toThrow()
      await expect(
        harness.payload.update({
          collection: ADD_ONS_SLUG,
          data: { tenant: null },
          id: docs.enhancedA.id,
          overrideAccess: true,
        }),
      ).rejects.toThrow(/tenant/i)
    })

    it('copies the currency from the tenant and rejects unknown placements', async () => {
      const doc = (await createAddOn(harness.tenantB.id, { currency: 'USD', key: 'cur-check' })) as unknown as {
        currency: string
      }
      expect(doc.currency).toBe('NZD')
      await expect(createAddOn(harness.tenantA.id, { key: 'sideways', placement: 'sideways' })).rejects.toThrow()
    })
  })

  describe('grants', () => {
    it('stores Premium granting 30 days of Enhanced, and quote() gives it for free', async () => {
      const premium = await createAddOn(harness.tenantA.id, {
        grants: [{ addOn: docs.enhancedA.id, durationDays: 30 }],
        key: 'premium',
        name: 'Premium',
        placement: 'featured-in-category',
        price: 5000,
      })

      // Checkout reads at depth 0 and passes the tenant's add-ons as the catalog.
      const { docs: catalog } = await harness.payload.find({
        collection: ADD_ONS_SLUG,
        depth: 0,
        overrideAccess: true,
        where: { tenant: { equals: harness.tenantA.id } },
      })
      const premiumDoc = catalog.find((doc) => doc.id === premium.id) as unknown as QuotableAddOn
      const plan = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ key: 'grants-plan' }), tenant: harness.tenantA.id },
        overrideAccess: true,
      })) as unknown as QuotablePlan

      const result = quote({
        addOnCatalog: catalog as unknown as QuotableAddOn[],
        addOns: [premiumDoc],
        currency: 'VUV',
        plan,
      })

      expect(result.total).toBe(10000)
      expect(result.entitlements.addOns.map((row) => [row.ref.id, row.source, row.durationDays])).toEqual([
        [premium.id, 'purchase', 30],
        [docs.enhancedA.id, 'grant', 30],
      ])
    })

    it('refuses grants from another tenant, of itself, twice, or in a cycle', async () => {
      await expect(
        createAddOn(harness.tenantA.id, {
          grants: [{ addOn: docs.enhancedB.id, durationDays: 30 }],
          key: 'cross',
        }),
      ).rejects.toThrow()

      const a = await createAddOn(harness.tenantA.id, { key: 'cycle-a' })
      const b = await createAddOn(harness.tenantA.id, {
        grants: [{ addOn: a.id, durationDays: 5 }],
        key: 'cycle-b',
      })

      for (const grants of [
        [{ addOn: a.id, durationDays: 5 }], // itself
        [{ addOn: b.id, durationDays: 5 }], // a → b → a
        [
          { addOn: docs.enhancedA.id, durationDays: 5 },
          { addOn: docs.enhancedA.id, durationDays: 9 },
        ],
      ]) {
        await expect(
          harness.payload.update({ collection: ADD_ONS_SLUG, data: { grants }, id: a.id, overrideAccess: true }),
        ).rejects.toThrow()
      }
    })
  })

  describe('plans include add-ons', () => {
    it('includes an add-on from the plan’s tenant, but not another tenant’s or one twice', async () => {
      const ok = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: {
          ...planData({ includedAddOns: [{ addOn: docs.enhancedA.id, durationDays: 14 }], key: 'enhanced-listing' }),
          tenant: harness.tenantA.id,
        },
        overrideAccess: true,
      })) as { id: number }
      expect(ok.id).toBeDefined()

      for (const includedAddOns of [
        [{ addOn: docs.enhancedB.id }],
        [{ addOn: docs.enhancedA.id }, { addOn: docs.enhancedA.id }],
      ]) {
        await expect(
          harness.payload.create({
            collection: PLANS_SLUG,
            data: { ...planData({ includedAddOns, key: 'bad-include' }), tenant: harness.tenantA.id },
            overrideAccess: true,
          }),
        ).rejects.toThrow()
      }
    })

    it('refuses to delete an add-on a plan includes or another add-on grants', async () => {
      const used = await createAddOn(harness.tenantA.id, { key: 'in-use' })
      const plan = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: {
          ...planData({ includedAddOns: [{ addOn: used.id }], key: 'uses-it', status: 'archived' }),
          tenant: harness.tenantA.id,
        },
        overrideAccess: true,
      })) as { id: number }
      const giver = await createAddOn(harness.tenantA.id, {
        grants: [{ addOn: used.id, durationDays: 5 }],
        key: 'gives-it',
      })

      const remove = () =>
        harness.payload.delete({
          collection: ADD_ONS_SLUG,
          id: used.id,
          overrideAccess: false,
          user: harness.superAdmin as never,
        })

      await expect(remove()).rejects.toThrow(/Mark it inactive instead/)
      await harness.payload.update({ collection: PLANS_SLUG, data: { includedAddOns: [] }, id: plan.id, overrideAccess: true })
      await expect(remove()).rejects.toThrow(/gives-it|Gives|add-ons/i)
      await harness.payload.update({ collection: ADD_ONS_SLUG, data: { grants: [] }, id: giver.id, overrideAccess: true })
      await remove()
    })
  })

  describe('seed', () => {
    // Listed with Premium first: the seed still creates Enhanced before Premium grants it.
    const seed: AddOnSeed[] = [
      {
        durationDays: 14,
        grants: [{ addOnKey: 'enhanced', durationDays: 30 }],
        key: 'premium',
        legacyKey: '_jr_featured-cat',
        name: 'Premium',
        placement: 'featured-in-category',
        price: 5000,
        sortOrder: 20,
      },
      {
        durationDays: 30,
        key: 'enhanced',
        legacyKey: '_jr_featured-listings',
        name: 'Enhanced',
        placement: 'featured-in-listings',
        price: 2000,
        sortOrder: 10,
      },
    ]

    it('creates add-ons in grant order, once, without overwriting edits', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Seeded' })

      expect(await seedAddOns({ addOns: seed, payload: harness.payload, tenantID: tenant.id })).toEqual({
        created: ['premium', 'enhanced'],
        existing: [],
      })

      const { docs: seeded } = await harness.payload.find({
        collection: ADD_ONS_SLUG,
        depth: 0,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      const byKey = Object.fromEntries(seeded.map((doc) => [doc.key, doc]))
      expect(byKey.premium.grants).toMatchObject([{ addOn: byKey.enhanced.id, durationDays: 30 }])

      await harness.payload.update({
        collection: ADD_ONS_SLUG,
        data: { price: 2500 },
        id: byKey.enhanced.id,
        overrideAccess: true,
      })
      expect(await seedAddOns({ addOns: seed, payload: harness.payload, tenantID: tenant.id })).toEqual({
        created: [],
        existing: ['premium', 'enhanced'],
      })
      const enhanced = await harness.payload.findByID({
        collection: ADD_ONS_SLUG,
        id: byKey.enhanced.id,
        overrideAccess: true,
      })
      expect(enhanced.price).toBe(2500)
    })

    it('treats an add-on imported under the same legacy meta key as existing', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Imported add-ons' })
      await createAddOn(tenant.id, { key: 'featured', legacyKey: '_jr_featured-listings' })

      // Premium's grant names `enhanced`, which isn't in this tenant under that key.
      await expect(
        seedAddOns({ addOns: [seed[1]], payload: harness.payload, tenantID: tenant.id }),
      ).resolves.toEqual({ created: [], existing: ['enhanced'] })
    })

    it('refuses the whole seed for a grant of an add-on the tenant does not have', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Missing grant' })

      await expect(
        seedAddOns({ addOns: [seed[0]], payload: harness.payload, tenantID: tenant.id }),
      ).rejects.toThrow(/no add-on "enhanced" to grant/)

      const { totalDocs } = await harness.payload.count({
        collection: ADD_ONS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('checks every field before writing, so a bad entry never leaves a partial seed', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Malformed add-ons' })
      const { legacyKey: _shared, ...base } = seed[1]
      const malformed: AddOnSeed[] = [
        { ...base, key: 'fine' },
        { ...base, key: 'bad-price', price: 9.5 },
        { ...base, key: 'bad-sort', sortOrder: 1.5 },
        { ...base, key: 'bad-placement', placement: 'sideways' as never },
        { ...base, grants: [{ addOnKey: 'fine', durationDays: 0 }], key: 'bad-grant' },
        { ...base, key: 'bad-field', ...({ colour: 'gold' } as object) },
        { ...base, durationDays: null, key: 'unconfirmed' },
      ]

      expect(addOnSeedProblems(malformed)).toEqual([
        '"bad-price": Price must be a whole number of minor units, 0 or more (VUV has none, so 2500 is Vt 2,500)',
        '"bad-sort": Sort order must be a whole number',
        '"bad-placement": Placement must be one of featured-in-listings, featured-in-category',
        '"bad-grant": duration of granted "fine" must be 1 day or more',
        '"bad-field": unknown field "colour"',
        '"unconfirmed": duration is not confirmed',
      ])
      await expect(
        seedAddOns({ addOns: malformed, payload: harness.payload, tenantID: tenant.id }),
      ).rejects.toThrow(AddOnSeedError)

      const { totalDocs } = await harness.payload.count({
        collection: ADD_ONS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('reports grant cycles in the seed itself', () => {
      expect(
        addOnSeedProblems([
          { ...seed[1], grants: [{ addOnKey: 'premium', durationDays: 5 }] },
          seed[0],
        ]),
      ).toEqual(['the seeded grants form a cycle'])
    })
  })
})

describe('expire-job-placements task', () => {
  let harness: TestHarness
  const DAY = 24 * 60 * 60 * 1000
  const at = (days: number) => new Date(Date.now() + days * DAY).toISOString()
  const placement = (kind: JobPlacement['placement'], from: number, to: number) => ({
    expiresAt: at(to),
    placement: kind,
    startsAt: at(from),
  })

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [addOnCollection(), Jobs],
      tenantData,
      tenantFields,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('removes only ended placements, across batches, and leaves other jobs untouched', async () => {
    const jobs = [
      [placement('featured-in-listings', -30, -1), placement('featured-in-category', -1, 10)],
      [placement('featured-in-listings', -30, -2)],
      [placement('featured-in-category', -2, 5)],
      [],
      [placement('featured-in-category', -40, -10), placement('featured-in-listings', -40, -5)],
    ]
    const ids: number[] = []
    for (const [index, placements] of jobs.entries()) {
      const doc = (await harness.payload.create({
        collection: 'jobs',
        data: { placements, tenant: index % 2 ? harness.tenantB.id : harness.tenantA.id, title: `Job ${index}` },
        overrideAccess: true,
      })) as { id: number }
      ids.push(doc.id)
    }

    const task = expireJobPlacementsTask({ batchSize: 2 })
    const run = () =>
      (task.handler as (args: unknown) => Promise<{ output: Record<string, number> }>)({
        req: { payload: harness.payload },
      })

    expect((await run()).output).toEqual({ jobsUpdated: 3, placementsRemoved: 4 })
    // Running again, or late, changes nothing.
    expect((await run()).output).toEqual({ jobsUpdated: 0, placementsRemoved: 0 })

    const after = await Promise.all(
      ids.map(async (id) => {
        const doc = (await harness.payload.findByID({
          collection: 'jobs',
          id,
          overrideAccess: true,
        })) as unknown as { placements: JobPlacement[] }
        return doc.placements.map((row) => row.placement)
      }),
    )
    expect(after).toEqual([['featured-in-category'], [], ['featured-in-category'], [], []])
  })
})
