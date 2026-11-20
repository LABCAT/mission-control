import type { CollectionConfig, Field, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import { planCollection, PLANS_SLUG, withPlanRestrictionGuards } from './plans'
import { PlanSeedError, planSeedProblems, seedPlans, type PlanSeed } from './plans-seed'
import { quote, snapshotQuote, type QuotablePlan } from './pricing'
import { taxonomyCollections } from './taxonomies'
import { hashSiteKey } from './site-keys'
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

const planData = (overrides: Record<string, unknown> = {}) => ({
  durationDays: 30,
  jobCredits: 1,
  key: 'regular-listing',
  name: 'Regular listing',
  price: 5000,
  ...overrides,
})

/** Plans relate to job types, categories and add-ons, so every boot includes them. */
const taxonomies = (): CollectionConfig[] => [
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
  addOnCollection(),
]

tenantIsolation({
  boot: { tenantData, tenantFields },
  collection: planCollection(),
  createData: () => planData(),
  extraCollections: taxonomies(),
})

/** The local API fills in the rest of a partial request, keeping these headers. */
const anonymousReq = async (key?: string): Promise<PayloadRequest> =>
  ({ headers: new Headers(key ? { 'x-site-key': key } : {}) }) as PayloadRequest

/** Ascending numeric order. Sorts a copy; `toSorted` is ES2023, past this package's lib. */
// oxlint-disable-next-line unicorn/no-array-sort
const ascending = (ids: number[]): number[] => [...ids].sort((a, b) => a - b)

type User = { collection: 'users'; id: number; role: 'user'; tenants: { role: string; tenant: number }[] }

describe('plans', () => {
  let harness: TestHarness
  let hub: TestTenant
  let noCurrency: TestTenant
  const extraUserIDs: number[] = []
  const extraTenantIDs: number[] = []
  const users: Record<'editorA' | 'employerA' | 'mixed' | 'seekerA', User> = {} as never
  const plans: Record<'activeA' | 'archivedA' | 'activeB', { id: number }> = {} as never
  const tax: Record<'fullTimeA' | 'fullTimeB' | 'healthA' | 'ngoA' | 'voluntaryA', number> = {} as never
  const keys: Record<'tenantA' | 'hub' | 'unknown', string> = {
    hub: 'sk_test_hub',
    tenantA: 'sk_test_tenant_a',
    unknown: 'sk_test_unknown',
  }

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

  /** IDs a caller can see, or [] when access is denied outright. */
  const visible = async (args: { req?: PayloadRequest; user?: unknown }): Promise<number[]> => {
    try {
      const { docs } = await harness.payload.find({
        collection: PLANS_SLUG,
        depth: 0,
        limit: 100,
        overrideAccess: false,
        req: args.req,
        user: args.user as never,
      })
      return ascending(docs.map((doc) => Number(doc.id)))
    } catch (error) {
      if ((error as { status?: number }).status === 403) return []
      throw error
    }
  }

  const storedTenant = async (id: number) =>
    (
      (await harness.payload.findByID({
        collection: PLANS_SLUG,
        depth: 0,
        id,
        overrideAccess: true,
      })) as unknown as { tenant: number | null }
    ).tenant

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [planCollection(), ...taxonomies()],
      globalCollections: [SiteKeys],
      tenantData,
      tenantFields,
    })

    hub = await makeTenant({ isAggregate: true, name: 'Hub' })
    noCurrency = await makeTenant({ name: 'No currency' })

    const { tenantA, tenantB } = harness
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: tenantA.id }])
    users.employerA = await makeUser('employer-a', [{ role: 'employer', tenant: tenantA.id }])
    users.seekerA = await makeUser('seeker-a', [{ role: 'seeker', tenant: tenantA.id }])
    // Staff in A, employer in B: sees all of A but only B's active plans.
    users.mixed = await makeUser('mixed', [
      { role: 'tenant-admin', tenant: tenantA.id },
      { role: 'employer', tenant: tenantB.id },
    ])

    const create = (tenant: number, data: Record<string, unknown>) =>
      harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData(data), tenant },
        overrideAccess: true,
      }) as Promise<{ id: number }>

    plans.activeA = await create(tenantA.id, {})
    plans.archivedA = await create(tenantA.id, { key: 'old-listing', status: 'archived' })
    plans.activeB = await create(tenantB.id, { price: 2500 })
    await create(tenantB.id, { key: 'old-listing', status: 'archived' })

    const term = async (collection: string, tenant: number, slug: string, extra = {}) =>
      (
        (await harness.payload.create({
          collection,
          data: { name: slug, slug, tenant, ...extra },
          overrideAccess: true,
        })) as { id: number }
      ).id
    tax.voluntaryA = await term('job-types', tenantA.id, 'voluntary', { isVolunteer: true })
    tax.fullTimeA = await term('job-types', tenantA.id, 'full-time')
    tax.fullTimeB = await term('job-types', tenantB.id, 'full-time')
    tax.healthA = await term('job-categories', tenantA.id, 'health')
    tax.ngoA = await term('job-categories', tenantA.id, 'ngo')

    for (const [key, tenant] of [
      [keys.tenantA, tenantA.id],
      [keys.hub, hub.id],
    ] as const) {
      await harness.payload.create({
        collection: 'site-keys',
        data: { keyHash: await hashSiteKey(key), tenant },
        overrideAccess: true,
      })
    }
  })

  afterAll(async () => {
    if (!harness) return
    const { payload } = harness
    await payload.delete({ collection: 'site-keys', overrideAccess: true, where: { id: { exists: true } } })
    await payload.delete({ collection: PLANS_SLUG, overrideAccess: true, where: { id: { exists: true } } })
    if (extraUserIDs.length) {
      await payload.delete({ collection: 'users', overrideAccess: true, where: { id: { in: extraUserIDs } } })
    }
    if (extraTenantIDs.length) {
      await payload.delete({ collection: 'tenants', overrideAccess: true, where: { id: { in: extraTenantIDs } } })
    }
    await harness.destroy()
  })

  describe('read access', () => {
    it('shows staff every plan in their tenant, archived included', async () => {
      const expected = ascending([plans.activeA.id, plans.archivedA.id])
      expect(await visible({ user: harness.tenantAdminA })).toEqual(expected)
      expect(await visible({ user: users.editorA })).toEqual(expected)
    })

    it('shows employers only the active plans of their tenant', async () => {
      expect(await visible({ user: users.employerA })).toEqual([plans.activeA.id])
    })

    it('applies each role to its own tenant only', async () => {
      expect(await visible({ user: users.mixed })).toEqual(
        ascending([plans.activeA.id, plans.archivedA.id, plans.activeB.id]),
      )
    })

    it('shows seekers nothing', async () => {
      expect(await visible({ user: users.seekerA })).toEqual([])
    })

    it('shows an anonymous request nothing without a valid site key', async () => {
      expect(await visible({ req: await anonymousReq() })).toEqual([])
      expect(await visible({ req: await anonymousReq(keys.unknown) })).toEqual([])
    })

    it('shows a site key the active plans of its tenant', async () => {
      expect(await visible({ req: await anonymousReq(keys.tenantA) })).toEqual([plans.activeA.id])
    })

    it('shows the aggregate site key the active plans of every tenant', async () => {
      expect(await visible({ req: await anonymousReq(keys.hub) })).toEqual(
        ascending([plans.activeA.id, plans.activeB.id]),
      )
    })
  })

  describe('write access', () => {
    it('lets a tenant editor create and update plans in their tenant', async () => {
      const created = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ key: 'editor-made' }), tenant: harness.tenantA.id },
        overrideAccess: false,
        user: users.editorA as never,
      })) as { currency: string; id: number }
      expect(created.currency).toBe('VUV')

      const updated = (await harness.payload.update({
        collection: PLANS_SLUG,
        data: { price: 6000 },
        id: created.id,
        overrideAccess: false,
        user: users.editorA as never,
      })) as unknown as { price: number }
      expect(updated.price).toBe(6000)
    })

    it('does not let employers, seekers or anonymous requests write', async () => {
      for (const user of [users.employerA, users.seekerA, undefined]) {
        await expect(
          harness.payload.create({
            collection: PLANS_SLUG,
            data: { ...planData({ key: 'nope' }), tenant: harness.tenantA.id },
            overrideAccess: false,
            user: user as never,
          }),
        ).rejects.toThrow()
        await expect(
          harness.payload.update({
            collection: PLANS_SLUG,
            data: { price: 1 },
            id: plans.activeA.id,
            overrideAccess: false,
            user: user as never,
          }),
        ).rejects.toThrow()
      }
    })

    it('does not let an employer in B edit B’s plans even if they are staff in A', async () => {
      await expect(
        harness.payload.update({
          collection: PLANS_SLUG,
          data: { price: 1 },
          id: plans.activeB.id,
          overrideAccess: false,
          user: users.mixed as never,
        }),
      ).rejects.toThrow()
    })

    it('does not let a tenant admin delete a plan: they archive it', async () => {
      await expect(
        harness.payload.delete({
          collection: PLANS_SLUG,
          id: plans.activeA.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('rejects a plan with no tenant, even from a super admin', async () => {
      await expect(
        harness.payload.create({
          collection: PLANS_SLUG,
          data: planData({ key: 'orphan' }),
          overrideAccess: false,
          user: harness.superAdmin as never,
        }),
      ).rejects.toThrow()
    })
  })

  describe('tenant cannot be cleared', () => {
    it('rejects an editor update that sets tenant to null', async () => {
      await expect(
        harness.payload.update({
          collection: PLANS_SLUG,
          data: { tenant: null },
          id: plans.activeA.id,
          overrideAccess: false,
          user: users.editorA as never,
        }),
      ).rejects.toThrow()
      expect(await storedTenant(plans.activeA.id)).toBe(harness.tenantA.id)
    })

    it('rejects a tenant-admin update that sets tenant to null alongside other changes', async () => {
      await expect(
        harness.payload.update({
          collection: PLANS_SLUG,
          data: { price: 1, tenant: null },
          id: plans.activeA.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
      expect(await storedTenant(plans.activeA.id)).toBe(harness.tenantA.id)
    })

    it('rejects clearing the tenant even where access lets the write through', async () => {
      for (const args of [
        { overrideAccess: false, user: harness.superAdmin as never },
        { overrideAccess: true },
      ]) {
        await expect(
          harness.payload.update({
            collection: PLANS_SLUG,
            data: { tenant: null },
            id: plans.activeA.id,
            ...args,
          }),
        ).rejects.toThrow(/tenant/i)
      }
      expect(await storedTenant(plans.activeA.id)).toBe(harness.tenantA.id)
    })

    it('still lets an editor update a plan without sending the tenant', async () => {
      const updated = (await harness.payload.update({
        collection: PLANS_SLUG,
        data: { sortOrder: 5 },
        id: plans.activeA.id,
        overrideAccess: false,
        user: users.editorA as never,
      })) as unknown as { sortOrder: number; tenant: number | { id: number } }

      expect(updated.sortOrder).toBe(5)
      expect(typeof updated.tenant === 'object' ? updated.tenant.id : updated.tenant).toBe(
        harness.tenantA.id,
      )
    })
  })

  describe('restrictions', () => {
    it('stores volunteer, job type and category restrictions, and quote() enforces them', async () => {
      const created = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: {
          ...planData({
            allowedJobCategories: [tax.healthA, tax.ngoA],
            allowedJobTypes: [tax.voluntaryA],
            isVolunteer: true,
            key: 'restricted',
            price: 0,
          }),
          tenant: harness.tenantA.id,
        },
        overrideAccess: true,
      })) as { id: number }

      // Checkout passes the job's type as the stored document, which carries its own flag.
      const typeDoc = (id: number) =>
        harness.payload.findByID({
          collection: 'job-types',
          depth: 0,
          id,
          overrideAccess: true,
        }) as Promise<{ id: number; isVolunteer: boolean }>
      const voluntary = await typeDoc(tax.voluntaryA)
      const fullTime = await typeDoc(tax.fullTimeA)

      // The plan as checkout reads it: ids at depth 0, documents at depth 1. Both quote the same.
      for (const depth of [0, 1]) {
        const plan = (await harness.payload.findByID({
          collection: PLANS_SLUG,
          depth,
          id: created.id,
          overrideAccess: true,
        })) as unknown as QuotablePlan

        expect(plan.isVolunteer).toBe(true)
        expect(quote({ job: { categories: [tax.ngoA], type: voluntary }, plan }).total).toBe(0)
        expect(() => quote({ job: { categories: [tax.ngoA], type: fullTime }, plan })).toThrow(
          /only for voluntary jobs/,
        )
        // A bare type id can't prove the job is voluntary.
        expect(() => quote({ job: { categories: [tax.ngoA], type: tax.voluntaryA }, plan })).toThrow(
          /pass the job type document/,
        )
      }
    })

    it('refuses to delete a job type or category a plan is restricted to', async () => {
      const type = (await harness.payload.create({
        collection: 'job-types',
        data: { name: 'Internship', slug: 'internship', tenant: harness.tenantA.id },
        overrideAccess: true,
      })) as { id: number }
      const plan = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: {
          ...planData({ allowedJobTypes: [type.id], key: 'internships', status: 'archived' }),
          tenant: harness.tenantA.id,
        },
        overrideAccess: true,
      })) as { id: number }

      await expect(
        harness.payload.delete({ collection: 'job-types', id: type.id, overrideAccess: true }),
      ).rejects.toThrow(/Remove it from those plans first/)

      // Once no plan uses it, it can go.
      await harness.payload.update({
        collection: PLANS_SLUG,
        data: { allowedJobTypes: [] },
        id: plan.id,
        overrideAccess: true,
      })
      await harness.payload.delete({ collection: 'job-types', id: type.id, overrideAccess: true })
    })

    it('does not block deleting a tenant, or clearing up what it leaves behind', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Leaving' })
      const type = (await harness.payload.create({
        collection: 'job-types',
        data: { name: 'Leaving type', slug: 'leaving', tenant: tenant.id },
        overrideAccess: true,
      })) as { id: number }
      await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ allowedJobTypes: [type.id], key: 'leaving' }), tenant: tenant.id },
        overrideAccess: true,
      })

      await harness.payload.delete({ collection: 'tenants', id: tenant.id, overrideAccess: true })

      // The plan's tenant is now null, so it no longer protects the job type.
      await harness.payload.delete({ collection: 'job-types', id: type.id, overrideAccess: true })
      const { totalDocs } = await harness.payload.count({
        collection: 'job-types',
        overrideAccess: true,
        where: { id: { equals: type.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('rejects job types or categories from another tenant', async () => {
      for (const bad of [{ allowedJobTypes: [tax.fullTimeB] }, { allowedJobTypes: [tax.fullTimeA, tax.fullTimeB] }]) {
        await expect(
          harness.payload.create({
            collection: PLANS_SLUG,
            data: { ...planData({ key: 'cross-tenant', ...bad }), tenant: harness.tenantA.id },
            overrideAccess: true,
          }),
        ).rejects.toThrow()
      }
      await expect(
        harness.payload.update({
          collection: PLANS_SLUG,
          data: { allowedJobTypes: [tax.fullTimeB] },
          id: plans.activeA.id,
          overrideAccess: false,
          user: users.editorA as never,
        }),
      ).rejects.toThrow()
    })
  })

  describe('data rules', () => {
    it('copies the currency from the tenant and ignores a submitted one', async () => {
      const doc = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ key: 'cur-check' }), currency: 'USD', tenant: harness.tenantB.id },
        overrideAccess: true,
      })) as unknown as { currency: string }
      expect(doc.currency).toBe('NZD')
    })

    it('refuses plans on a tenant without a currency, such as the hub', async () => {
      for (const tenant of [hub.id, noCurrency.id]) {
        await expect(
          harness.payload.create({
            collection: PLANS_SLUG,
            data: { ...planData({ key: 'no-cur' }), tenant },
            overrideAccess: true,
          }),
        ).rejects.toThrow(/currency/i)
      }
    })

    it('rejects fractional or negative prices and zero durations', async () => {
      for (const bad of [{ price: 49.5 }, { price: -1 }, { durationDays: 0 }, { jobCredits: 0 }]) {
        await expect(
          harness.payload.create({
            collection: PLANS_SLUG,
            data: { ...planData({ key: 'bad', ...bad }), tenant: harness.tenantA.id },
            overrideAccess: true,
          }),
        ).rejects.toThrow()
      }
    })

    it('keeps keys unique per tenant but allows the same key in another tenant', async () => {
      await expect(
        harness.payload.create({
          collection: PLANS_SLUG,
          data: { ...planData(), tenant: harness.tenantA.id },
          overrideAccess: true,
        }),
      ).rejects.toThrow(/invalid: key/)
      // plans.activeB already has `regular-listing` in tenant B.
      expect(plans.activeB.id).toBeDefined()
    })
  })

  describe('archiving', () => {
    it('keeps an archived plan for staff and past orders, but stops new sales', async () => {
      const plan = (await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ key: 'to-archive', price: 7000 }), tenant: harness.tenantA.id },
        overrideAccess: true,
      })) as QuotablePlan & { id: number }

      const snapshot = snapshotQuote(quote({ currency: 'VUV', plan }))

      await harness.payload.update({
        collection: PLANS_SLUG,
        data: { name: 'Renamed', price: 9000, status: 'archived' },
        id: plan.id,
        overrideAccess: false,
        user: harness.tenantAdminA as never,
      })

      const archived = (await harness.payload.findByID({
        collection: PLANS_SLUG,
        id: plan.id,
        overrideAccess: true,
      })) as QuotablePlan

      // Still there for staff and for the order's relationship...
      expect(await visible({ user: harness.tenantAdminA })).toContain(plan.id)
      // ...gone from the shop...
      expect(await visible({ user: users.employerA })).not.toContain(plan.id)
      expect(await visible({ req: await anonymousReq(keys.tenantA) })).not.toContain(plan.id)
      expect(() => quote({ plan: archived })).toThrow(/archived/)
      // ...and the past order still says what was bought, at the old price.
      expect(snapshot.plan).toMatchObject({ name: 'Regular listing', price: 7000 })
      expect(snapshot.total).toBe(7000)
    })
  })

  describe('seed', () => {
    const seed: PlanSeed[] = [
      { durationDays: 30, jobCredits: 1, key: 'single', name: 'Single', price: 5000, sortOrder: 1 },
      {
        creditExpiryDays: 365,
        durationDays: 30,
        jobCredits: 10,
        key: 'pack',
        legacyId: 99,
        name: 'Pack',
        price: 40000,
        sortOrder: 2,
      },
    ]

    it('creates missing plans once and never overwrites existing ones', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Seeded' })

      const first = await seedPlans({ payload: harness.payload, plans: seed, tenantID: tenant.id })
      expect(first).toEqual({ created: ['single', 'pack'], existing: [] })

      const { docs } = await harness.payload.find({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { and: [{ tenant: { equals: tenant.id } }, { key: { equals: 'single' } }] },
      })
      await harness.payload.update({
        collection: PLANS_SLUG,
        data: { price: 5500 },
        id: docs[0].id,
        overrideAccess: true,
      })

      const second = await seedPlans({ payload: harness.payload, plans: seed, tenantID: tenant.id })
      expect(second).toEqual({ created: [], existing: ['single', 'pack'] })

      const after = await harness.payload.find({
        collection: PLANS_SLUG,
        overrideAccess: true,
        sort: 'sortOrder',
        where: { tenant: { equals: tenant.id } },
      })
      expect(after.docs.map((doc) => [doc.key, doc.price])).toEqual([
        ['single', 5500],
        ['pack', 40000],
      ])
    })

    it('treats a plan imported with the same legacyId as existing', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Imported' })
      await harness.payload.create({
        collection: PLANS_SLUG,
        data: { ...planData({ key: 'imported-pack', legacyId: 99 }), tenant: tenant.id },
        overrideAccess: true,
      })

      const result = await seedPlans({ payload: harness.payload, plans: seed, tenantID: tenant.id })
      expect(result).toEqual({ created: ['single'], existing: ['pack'] })
    })

    it('creates a plan with its included add-on, resolved by key in the tenant', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'With add-on' })
      const enhanced = (await harness.payload.create({
        collection: 'add-ons',
        data: {
          durationDays: 30,
          key: 'enhanced',
          name: 'Enhanced',
          placement: 'featured-in-listings',
          price: 2000,
          tenant: tenant.id,
        },
        overrideAccess: true,
      })) as { id: number }
      const withAddOn: PlanSeed = {
        ...seed[0],
        includedAddOns: [{ addOnKey: 'enhanced', durationDays: 14 }],
        key: 'enhanced-listing',
      }

      const result = await seedPlans({ payload: harness.payload, plans: [withAddOn], tenantID: tenant.id })
      expect(result).toEqual({ created: ['enhanced-listing'], existing: [] })

      const { docs } = await harness.payload.find({
        collection: PLANS_SLUG,
        depth: 0,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(docs[0]).toMatchObject({ includedAddOns: [{ addOn: enhanced.id, durationDays: 14 }] })
    })

    it('refuses the whole seed when an included add-on is not in the tenant', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'No add-ons' })

      await expect(
        seedPlans({
          payload: harness.payload,
          plans: [
            { ...seed[0], key: 'fine' },
            { ...seed[0], includedAddOns: [{ addOnKey: 'enhanced' }], key: 'enhanced-listing' },
          ],
          tenantID: tenant.id,
        }),
      ).rejects.toThrow(/no add-on "enhanced"/)

      const { totalDocs } = await harness.payload.count({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('checks every field before writing, so a bad entry never leaves a partial seed', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Malformed' })
      const malformed: PlanSeed[] = [
        { ...seed[0], key: 'fine-1' },
        { ...seed[0], creditExpiryDays: -30, key: 'bad-expiry' },
        { ...seed[0], key: 'bad-sort', sortOrder: 1.5 },
        { ...seed[0], key: 'bad-legacy', legacyId: 0 },
        { ...seed[0], key: 'bad-type', allowedJobTypes: ['Full Time'] },
        { ...seed[0], isVolunteer: 'yes' as never, key: 'bad-volunteer' },
        { ...seed[0], key: 'bad-field', ...({ creditExpiry: 30 } as object) },
        { ...seed[0], key: 'fine-2' },
      ]

      expect(planSeedProblems(malformed)).toEqual([
        '"bad-expiry": Credit expiry must be a whole number, 1 or more',
        '"bad-sort": Sort order must be a whole number',
        '"bad-legacy": Legacy id must be a whole number, 1 or more',
        '"bad-type": Allowed job types: "Full Time" is not a slug, e.g. full-time',
        '"bad-volunteer": Volunteer only must be true or false',
        '"bad-field": unknown field "creditExpiry"',
      ])
      await expect(
        seedPlans({ payload: harness.payload, plans: malformed, tenantID: tenant.id }),
      ).rejects.toThrow(PlanSeedError)

      const { totalDocs } = await harness.payload.count({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('resolves allowed job type and category slugs to the tenant’s ids', async () => {
      const result = await seedPlans({
        payload: harness.payload,
        plans: [
          {
            ...seed[0],
            allowedJobCategories: ['health'],
            allowedJobTypes: ['voluntary', 'full-time'],
            key: 'seeded-restricted',
          },
        ],
        tenantID: harness.tenantA.id,
      })
      expect(result.created).toEqual(['seeded-restricted'])

      const { docs } = await harness.payload.find({
        collection: PLANS_SLUG,
        depth: 0,
        overrideAccess: true,
        where: { key: { equals: 'seeded-restricted' } },
      })
      expect(docs[0]).toMatchObject({
        allowedJobCategories: [tax.healthA],
        allowedJobTypes: [tax.voluntaryA, tax.fullTimeA],
      })
    })

    it('refuses the whole seed when a slug has no taxonomy in the tenant', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'No taxonomies' })

      await expect(
        seedPlans({
          payload: harness.payload,
          plans: [
            { ...seed[0], key: 'fine' },
            { ...seed[0], allowedJobTypes: ['voluntary'], key: 'needs-type' },
          ],
          tenantID: tenant.id,
        }),
      ).rejects.toThrow(/no job type "voluntary"/)

      const { totalDocs } = await harness.payload.count({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('accepts exactly the seeds the collection would save', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Restricted seed' })
      const volunteer: PlanSeed = {
        ...seed[0],
        acceptsCredits: false,
        isVolunteer: true,
        key: 'volunteer',
        price: 0,
      }

      expect(planSeedProblems([volunteer])).toEqual([])
      expect(await seedPlans({ payload: harness.payload, plans: [volunteer], tenantID: tenant.id })).toEqual({
        created: ['volunteer'],
        existing: [],
      })
      const { docs } = await harness.payload.find({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(docs[0]).toMatchObject({ acceptsCredits: false, isVolunteer: true, price: 0 })
    })

    it('refuses to write anything while a value is unconfirmed', async () => {
      const tenant = await makeTenant({ currency: 'VUV', name: 'Unconfirmed' })
      const pending = [...seed, { ...seed[0], key: 'pending', price: null }]

      expect(planSeedProblems(pending)).toEqual(['"pending": price is not confirmed'])
      await expect(
        seedPlans({ payload: harness.payload, plans: pending, tenantID: tenant.id }),
      ).rejects.toThrow(PlanSeedError)

      const { totalDocs } = await harness.payload.count({
        collection: PLANS_SLUG,
        overrideAccess: true,
        where: { tenant: { equals: tenant.id } },
      })
      expect(totalDocs).toBe(0)
    })
  })
})
