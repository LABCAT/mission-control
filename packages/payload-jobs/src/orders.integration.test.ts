import type { CollectionConfig, Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MissionControlUser } from './access'
import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationField, organisationsCollection } from './collections/organisations'
import { couponCollection } from './coupons'
import { orderCollection, ORDERS_SLUG, refuseDeleteWhileOrdered } from './orders'
import { resolvePaymentProviders } from './payment-providers'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { quote, snapshotQuote } from './pricing'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

const tenantFields: Field[] = [{ name: 'currency', type: 'text' }]
const tenantData = (which: 'A' | 'B') => ({ currency: which === 'A' ? 'VUV' : 'NZD' })

/** A rejection whose message or field errors match `pattern` (Payload puts the detail in `data.errors`). */
const failsWith =
  (pattern: RegExp) =>
  (error: unknown): boolean => {
    const { data, message } = error as { data?: { errors?: { message?: string }[] }; message?: string }
    return pattern.test([message, ...(data?.errors ?? []).map((entry) => entry.message)].join(' | '))
  }

type User = MissionControlUser & { collection: 'users'; email: string; id: number; role: 'user' }
type Doc = Record<string, any> & { id: number }

/** Owners are named by the host; the test host keeps a list. */
const owners = new Set<string>()

const withGuard = (collection: CollectionConfig, field: 'jobs' | 'organisation', noun: string): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    beforeDelete: [refuseDeleteWhileOrdered({ field, noun }), ...(collection.hooks?.beforeDelete ?? [])],
  },
})

/** Orders first: the harness clean-up deletes in this order, and the guards keep ordered documents. */
const collections = (): CollectionConfig[] => [
  orderCollection({
    isOrganisationOwner: ({ user }) => owners.has(String(user.id)),
    paymentProviders: resolvePaymentProviders([{ key: 'stripe', label: 'Card' }]),
  }),
  withGuard(jobsCollection({ richTextDescription: false, withOrder: true }), 'jobs', 'job'),
  couponCollection(),
  withGuard(organisationsCollection({ mediaSlug: null }), 'organisation', 'organisation'),
  planCollection(),
  addOnCollection(),
  locationsCollection({ requireTenant: true }),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

describe('orders integration', () => {
  let harness: TestHarness
  const users: Record<string, User> = {}
  const orgs: Record<string, Doc> = {}
  const plans: Record<string, Doc> = {}
  const jobs: Record<string, Doc> = {}
  let coupon: Doc
  let addOn: Doc

  const makeUser = async (label: string, tenants: User['tenants'], extra: Record<string, unknown> = {}): Promise<User> => {
    const doc = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
        ...extra,
      },
      overrideAccess: true,
    })) as Doc
    return { collection: 'users', email: doc.email, id: doc.id, role: 'user', tenants, ...extra } as User
  }

  const system = { overrideAccess: true } as const

  /** A plain invoice order: 5000 with no tax, made by system code (checkout). */
  const invoiceOrder = (tenant: number, organisation: number, extra: Record<string, unknown> = {}) => ({
    currency: tenant === harness.tenantA.id ? 'VUV' : 'NZD',
    discount: 0,
    organisation,
    paymentMethod: 'invoice',
    paymentProvider: 'invoice',
    subtotal: 5000,
    tax: 0,
    tenant,
    total: 5000,
    ...extra,
  })

  const createOrder = async (data: Record<string, unknown>, options: Record<string, unknown> = system): Promise<Doc> =>
    (await harness.payload.create({ collection: ORDERS_SLUG, data, ...options })) as Doc

  const read = async (id: number): Promise<Doc> =>
    (await harness.payload.findByID({ collection: ORDERS_SLUG, depth: 0, id, overrideAccess: true })) as Doc

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      tenantData,
      tenantFields,
      tenantHooks: { beforeDelete: [refuseDeleteWhileOrdered({ field: 'tenant', noun: 'tenant' })] },
      userFields: [organisationField()],
    })
    const { tenantA, tenantB } = harness

    const org = async (tenant: number, name: string) =>
      (await harness.payload.create({
        collection: 'organisations',
        data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 6)}`, tenant },
        ...system,
      })) as Doc
    orgs.brewA = await org(tenantA.id, 'Brew')
    orgs.bankA = await org(tenantA.id, 'Bank')
    orgs.shopB = await org(tenantB.id, 'Shop')

    const plan = async (tenant: number) =>
      (await harness.payload.create({
        collection: 'plans',
        data: { durationDays: 30, jobCredits: 1, key: 'regular-listing', name: 'Regular', price: 5000, tenant },
        ...system,
      })) as Doc
    plans.a = await plan(tenantA.id)
    plans.b = await plan(tenantB.id)

    addOn = (await harness.payload.create({
      collection: 'add-ons',
      data: { durationDays: 30, key: 'enhanced', name: 'Enhanced', placement: 'featured-in-listings', price: 1500, tenant: tenantA.id },
      ...system,
    })) as Doc
    coupon = (await harness.payload.create({
      collection: 'coupons',
      data: { amount: 10, code: 'LINKPS', discountType: 'percent', tenant: tenantA.id },
      ...system,
    })) as Doc

    const job = async (tenant: number, organisation: number, title: string) =>
      (await harness.payload.create({ collection: 'jobs', data: { organisation, tenant, title }, ...system })) as Doc
    jobs.brewA = await job(tenantA.id, orgs.brewA.id, 'Brewer')
    jobs.bankA = await job(tenantA.id, orgs.bankA.id, 'Teller')

    users.memberBrew = await makeUser('member-brew', [{ role: 'employer', tenant: tenantA.id }], { organisation: orgs.brewA.id })
    users.ownerBrew = await makeUser('owner-brew', [{ role: 'employer', tenant: tenantA.id }], { organisation: orgs.brewA.id })
    users.memberBank = await makeUser('member-bank', [{ role: 'employer', tenant: tenantA.id }], { organisation: orgs.bankA.id })
    users.memberShop = await makeUser('member-shop', [{ role: 'employer', tenant: tenantB.id }], { organisation: orgs.shopB.id })
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: tenantA.id }])
    users.seekerA = await makeUser('seeker-a', [{ role: 'seeker', tenant: tenantA.id }])
    owners.add(String(users.ownerBrew.id))
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  describe('access @S-146', () => {
    let brewOrder: Doc
    let bankOrder: Doc
    let shopOrder: Doc

    beforeAll(async () => {
      brewOrder = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id))
      bankOrder = await createOrder(invoiceOrder(harness.tenantA.id, orgs.bankA.id))
      shopOrder = await createOrder(invoiceOrder(harness.tenantB.id, orgs.shopB.id))
    })

    /** The orders a user can list. `false` access makes Payload refuse the find: that is none. */
    const visibleTo = async (user: unknown): Promise<number[]> => {
      const { docs } = await harness.payload
        .find({
        collection: ORDERS_SLUG,
        depth: 0,
        limit: 100,
        overrideAccess: false,
        user: user as never,
          where: { id: { in: [brewOrder.id, bankOrder.id, shopOrder.id] } },
        })
        .catch((error: Error) => {
          if (error.name === 'Forbidden') return { docs: [] }
          throw error
        })
      // oxlint-disable-next-line unicorn/no-array-sort
      return docs.map((doc) => Number(doc.id)).sort((a, b) => a - b)
    }

    it('lets members read their own organisation’s orders only', async () => {
      expect(await visibleTo(users.memberBrew)).toEqual([brewOrder.id])
      expect(await visibleTo(users.memberBank)).toEqual([bankOrder.id])
      expect(await visibleTo(users.memberShop)).toEqual([shopOrder.id])
    })

    it('lets a site manager read every order in their tenant, and no other tenant’s', async () => {
      expect(await visibleTo(harness.tenantAdminA)).toEqual([brewOrder.id, bankOrder.id])
      expect(await visibleTo(harness.tenantAdminB)).toEqual([shopOrder.id])
      expect(await visibleTo(harness.superAdmin)).toEqual([brewOrder.id, bankOrder.id, shopOrder.id])
    })

    it('shows editors, seekers and anonymous callers nothing', async () => {
      expect(await visibleTo(users.editorA)).toEqual([])
      expect(await visibleTo(users.seekerA)).toEqual([])
      await expect(visibleTo(undefined)).resolves.toEqual([])
    })

    it('hides the legacy id from members', async () => {
      await harness.payload.update({ collection: ORDERS_SLUG, data: { legacyId: 9001 }, id: brewOrder.id, ...system })
      const asMember = (await harness.payload.findByID({
        collection: ORDERS_SLUG,
        id: brewOrder.id,
        overrideAccess: false,
        user: users.memberBrew as never,
      })) as Doc
      expect(asMember.legacyId).toBeUndefined()
      expect(asMember.total).toBe(5000)
    })

    it('lets a member neither create nor change an order', async () => {
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id), { overrideAccess: false, user: users.memberBrew }),
      ).rejects.toThrow()
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { status: 'paid' },
          id: brewOrder.id,
          overrideAccess: false,
          user: users.memberBrew as never,
        }),
      ).rejects.toThrow()
      expect((await read(brewOrder.id)).status).toBe('pending')
    })

    it('keeps a site manager out of another tenant’s orders', async () => {
      await expect(
        createOrder(invoiceOrder(harness.tenantB.id, orgs.shopB.id), { overrideAccess: false, user: harness.tenantAdminA }),
      ).rejects.toThrow()
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { status: 'cancelled' },
          id: shopOrder.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
      expect((await read(shopOrder.id)).status).toBe('pending')
    })

    it('lets nobody delete an order, not even a super admin', async () => {
      await expect(
        harness.payload.delete({ collection: ORDERS_SLUG, id: brewOrder.id, overrideAccess: false, user: harness.superAdmin as never }),
      ).rejects.toThrow()
      expect(await read(brewOrder.id)).toBeTruthy()
    })
  })

  describe('status and history @S-146', () => {
    it('records who created the order and every status move, and stamps the payment date', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id), {
        overrideAccess: false,
        user: harness.tenantAdminA,
      })
      expect(order.status).toBe('pending')
      expect(order.createdBy).toMatchObject({ relationTo: 'users' })

      const update = (data: Record<string, unknown>) =>
        harness.payload.update({
          collection: ORDERS_SLUG,
          data,
          id: order.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        })

      await update({ status: 'invoiced' })
      await update({ status: 'paid', statusNote: 'Paid at the YCV office' })

      const stored = await read(order.id)
      expect(stored.status).toBe('paid')
      expect(stored.paidAt).toBeTruthy()
      expect(stored.statusNote).toBeUndefined()
      expect(stored.log.map((e: Doc) => [e.event, e.from ?? null, e.to, e.actor])).toEqual([
        ['created', null, 'pending', 'staff'],
        ['status', 'pending', 'invoiced', 'staff'],
        ['status', 'invoiced', 'paid', 'staff'],
      ])
      expect(String(stored.log[2].by)).toBe(String(harness.tenantAdminA.id))
      expect(stored.log[2].note).toBe('Paid at the YCV office')

      // Paid is final.
      await expect(update({ status: 'pending' })).rejects.toSatisfy(failsWith(/Paid to Pending/))
      await expect(update({ status: 'cancelled' })).rejects.toThrow()
    })

    it('keeps the history append-only, whatever a request sends for it', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id))
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { log: [], status: 'invoiced' },
        id: order.id,
        overrideAccess: false,
        user: harness.tenantAdminA as never,
      })
      // Even system code can't rewrite it after create.
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { log: [{ actor: 'system', at: new Date().toISOString(), event: 'created', to: 'paid' }] },
        id: order.id,
        ...system,
      })

      const stored = await read(order.id)
      expect(stored.log.map((e: Doc) => [e.event, e.to, e.actor])).toEqual([
        ['created', 'pending', 'system'],
        ['status', 'invoiced', 'staff'],
      ])
    })

    it('lets the owner answer a purchase request and nothing more', async () => {
      const request = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { status: 'waiting_for_purchase' }))
      const asUser = (user: User, data: Record<string, unknown>, id = request.id) =>
        harness.payload.update({ collection: ORDERS_SLUG, data, id, overrideAccess: false, user: user as never })

      // A member who isn't the owner can't approve.
      await expect(asUser(users.memberBrew, { status: 'pending' })).rejects.toThrow()

      await asUser(users.ownerBrew, { status: 'pending', statusNote: 'Approved' })
      let stored = await read(request.id)
      expect(stored.status).toBe('pending')
      expect(stored.log.at(-1)).toMatchObject({ actor: 'owner', event: 'status', note: 'Approved', to: 'pending' })

      // Marking paid is the site manager's.
      await expect(asUser(users.ownerBrew, { status: 'paid' })).rejects.toSatisfy(failsWith(/site manager/))
      // Field access keeps the owner out of everything but the status.
      await asUser(users.ownerBrew, { jobs: [jobs.brewA.id] })
      stored = await read(request.id)
      expect(stored.jobs ?? []).toEqual([])

      // Another organisation's owner gets nowhere.
      const bankRequest = await createOrder(
        invoiceOrder(harness.tenantA.id, orgs.bankA.id, { status: 'waiting_for_purchase' }),
      )
      await expect(asUser(users.ownerBrew, { status: 'pending' }, bankRequest.id)).rejects.toThrow()
      expect((await read(bankRequest.id)).status).toBe('waiting_for_purchase')
    })
  })

  describe('payment date @S-146', () => {
    it('stamps the payment date itself and ignores one a site manager sends', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { status: 'invoiced' }))
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { paidAt: '2020-01-01T00:00:00.000Z', status: 'paid' },
        id: order.id,
        overrideAccess: false,
        user: harness.tenantAdminA as never,
      })
      const paid = await read(order.id)
      expect(new Date(paid.paidAt).getFullYear()).toBeGreaterThan(2020)

      // A later attempt to move it is dropped by field access, and the history is unchanged.
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { paidAt: '2020-01-01T00:00:00.000Z' },
        id: order.id,
        overrideAccess: false,
        user: harness.tenantAdminA as never,
      })
      const after = await read(order.id)
      expect(after.paidAt).toBe(paid.paidAt)
      expect(after.log).toHaveLength(paid.log.length)
    })

    it('takes the payment date from system code, and records a correction', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { status: 'invoiced' }))
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { paidAt: '2026-11-19T00:00:00.000Z', status: 'paid' },
        id: order.id,
        ...system,
      })
      expect((await read(order.id)).paidAt).toBe('2026-11-19T00:00:00.000Z')

      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { paidAt: '2026-11-18T00:00:00.000Z' },
        id: order.id,
        ...system,
      })
      const corrected = await read(order.id)
      expect(corrected.log.at(-1)).toMatchObject({
        event: 'paid-at',
        from: '2026-11-19T00:00:00.000Z',
        to: '2026-11-18T00:00:00.000Z',
      })
      await expect(
        harness.payload.update({ collection: ORDERS_SLUG, data: { paidAt: null }, id: order.id, ...system }),
      ).rejects.toSatisfy(failsWith(/keeps its payment date/))
    })

    it('refuses a payment date on an order that is not paid', async () => {
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { paidAt: '2026-11-19T00:00:00.000Z' })),
      ).rejects.toSatisfy(failsWith(/Only a paid order/))
    })
  })

  describe('job order and author @S-146', () => {
    it('links a job only to its own organisation’s order, and shows the order and author to its members', async () => {
      const brewOrder = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id))
      const bankOrder = await createOrder(invoiceOrder(harness.tenantA.id, orgs.bankA.id))
      const job = (await harness.payload.create({
        collection: 'jobs',
        data: { organisation: orgs.brewA.id, tenant: harness.tenantA.id, title: 'Cellar hand' },
        overrideAccess: false,
        user: users.memberBrew as never,
      })) as Doc

      await expect(
        harness.payload.update({ collection: 'jobs', data: { order: bankOrder.id }, id: job.id, ...system }),
      ).rejects.toSatisfy(failsWith(/order of this job’s organisation/))
      await harness.payload.update({ collection: 'jobs', data: { order: brewOrder.id }, id: job.id, ...system })

      const asMember = (await harness.payload.findByID({
        collection: 'jobs',
        depth: 0,
        id: job.id,
        overrideAccess: false,
        user: users.memberBrew as never,
      })) as Doc
      expect(Number(asMember.order)).toBe(brewOrder.id)
      expect(asMember.createdBy).toMatchObject({ relationTo: 'users', value: users.memberBrew.id })

      // A member can't point the job at an order: it's set at checkout.
      await harness.payload.update({
        collection: 'jobs',
        data: { order: null },
        id: job.id,
        overrideAccess: false,
        user: users.memberBrew as never,
      })
      expect(Number((await harness.payload.findByID({ collection: 'jobs', id: job.id, depth: 0, ...system })).order)).toBe(
        brewOrder.id,
      )
    })
  })

  describe('money @S-146', () => {
    it('fills the money from a quote snapshot and keeps it fixed', async () => {
      const snapshot = snapshotQuote(
        quote({
          addOns: [{ ...addOn, currency: 'VUV' } as never],
          coupon: { amount: 10, code: 'LINKPS', discountType: 'percent', id: coupon.id },
          currency: 'VUV',
          plan: { ...plans.a, currency: 'VUV', status: 'active' } as never,
        }),
      )
      const order = await createOrder(
        { organisation: orgs.brewA.id, paymentProvider: 'invoice', quote: snapshot, tenant: harness.tenantA.id },
        { overrideAccess: false, user: harness.tenantAdminA },
      )

      expect(order).toMatchObject({
        couponCode: 'LINKPS',
        currency: 'VUV',
        discount: 650,
        subtotal: 6500,
        tax: 0,
        total: 5850,
      })
      expect(Number(order.plan?.id ?? order.plan)).toBe(plans.a.id)
      expect(Number(order.coupon?.id ?? order.coupon)).toBe(coupon.id)
      expect(order.addOns).toEqual([expect.objectContaining({ amount: 1500, key: 'enhanced', name: 'Enhanced' })])

      for (const data of [{ total: 1 }, { currency: 'NZD' }, { discount: 0 }, { taxLines: [] , tax: 5 }, { plan: plans.b.id }]) {
        await expect(
          harness.payload.update({
            collection: ORDERS_SLUG,
            data,
            id: order.id,
            overrideAccess: false,
            user: harness.tenantAdminA as never,
          }),
        ).rejects.toThrow()
      }
      // System code can't change sold money either.
      await expect(
        harness.payload.update({ collection: ORDERS_SLUG, data: { total: 0 }, id: order.id, ...system }),
      ).rejects.toSatisfy(failsWith(/Fixed once the order is created/))
      expect((await read(order.id)).total).toBe(5850)
    })

    it('refuses submitted money that disagrees with the quote', async () => {
      const snapshot = snapshotQuote(quote({ plan: { ...plans.a, currency: 'VUV', status: 'active' } as never }))
      await expect(
        createOrder({
          organisation: orgs.brewA.id,
          paymentProvider: 'invoice',
          quote: snapshot,
          tenant: harness.tenantA.id,
          total: 1,
        }),
      ).rejects.toSatisfy(failsWith(/match the quote/))
    })

    it('refuses money that does not add up', async () => {
      await expect(createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { total: 4999 }))).rejects.toSatisfy(failsWith(/total must be 5000/))
      await expect(createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { discount: 6000, total: 0 }))).rejects.toThrow()
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { subtotal: 50.5, total: 50.5 })),
      ).rejects.toThrow()
    })

    it('keeps free and credit orders at zero', async () => {
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { paymentMethod: 'free', paymentProvider: null })),
      ).rejects.toSatisfy(failsWith(/must total 0/))
      const free = await createOrder(
        invoiceOrder(harness.tenantA.id, orgs.brewA.id, {
          paymentMethod: 'credit',
          paymentProvider: null,
          status: 'paid',
          subtotal: 0,
          total: 0,
        }),
      )
      expect(free.paidAt).toBeTruthy()
    })
  })

  describe('payment providers and external references @S-146', () => {
    it('accepts only registered providers, and an invoice needs one', async () => {
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { paymentProvider: 'paypal' })),
      ).rejects.toSatisfy(failsWith(/registered payment provider/))
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { paymentProvider: null })),
      ).rejects.toSatisfy(failsWith(/payment provider/))
      const card = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { paymentProvider: 'stripe' }))
      expect(card.paymentProvider).toBe('stripe')

      // A site manager can't switch the provider afterwards.
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { paymentProvider: 'invoice' },
          id: card.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toSatisfy(failsWith(/Only system code/))
    })

    it('records external references in the history and never drops one', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id))
      const xero = { id: '0b0b5b8e-3a8b-4bd1-9f43-1f3f2b6c9a10', provider: 'xero', url: 'https://in.xero.com/abc' }
      await harness.payload.update({
        collection: ORDERS_SLUG,
        data: { externalRefs: [xero], status: 'invoiced' },
        id: order.id,
        ...system,
      })
      const stored = await read(order.id)
      expect(stored.externalRefs).toEqual([expect.objectContaining({ id: xero.id, provider: 'xero' })])
      expect(stored.log.map((e: Doc) => e.event)).toEqual(['created', 'status', 'external-ref'])

      await expect(
        harness.payload.update({ collection: ORDERS_SLUG, data: { externalRefs: [] }, id: order.id, ...system }),
      ).rejects.toSatisfy(failsWith(/kept once recorded/))
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { externalRefs: [xero, { ...xero, url: null }] },
          id: order.id,
          ...system,
        }),
      ).rejects.toSatisfy(failsWith(/only once/))
    })
  })

  describe('tenancy of relations @S-146', () => {
    it('keeps the organisation, plan, coupon and jobs inside the order’s tenant and organisation', async () => {
      await expect(createOrder(invoiceOrder(harness.tenantA.id, orgs.shopB.id))).rejects.toSatisfy(failsWith(/organisation/))
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { plan: plans.b.id })),
      ).rejects.toSatisfy(failsWith(/plan/))
      await expect(
        createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { jobs: [jobs.bankA.id] })),
      ).rejects.toSatisfy(failsWith(/jobs/))
      const ok = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { jobs: [jobs.brewA.id] }))
      expect(ok.jobs).toHaveLength(1)
    })

    it('never moves an order to another tenant, and only system code moves it to another organisation', async () => {
      const order = await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id))
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { tenant: harness.tenantB.id },
          id: order.id,
          user: harness.superAdmin as never,
          overrideAccess: false,
        }),
      ).rejects.toSatisfy(failsWith(/stays in its tenant/))
      await expect(
        harness.payload.update({
          collection: ORDERS_SLUG,
          data: { organisation: orgs.bankA.id },
          id: order.id,
          overrideAccess: false,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toSatisfy(failsWith(/Only system code/))

      // Merging organisations (system code) moves it, and says so in the history.
      await harness.payload.update({ collection: ORDERS_SLUG, data: { organisation: orgs.bankA.id }, id: order.id, ...system })
      const stored = await read(order.id)
      expect(Number(stored.organisation)).toBe(orgs.bankA.id)
      expect(stored.log.at(-1)).toMatchObject({ event: 'organisation', from: String(orgs.brewA.id), to: String(orgs.bankA.id) })
    })

    it('keeps the tenant, organisation and jobs an order points at', async () => {
      await createOrder(invoiceOrder(harness.tenantA.id, orgs.brewA.id, { jobs: [jobs.brewA.id] }))
      await expect(
        harness.payload.delete({ collection: 'organisations', id: orgs.brewA.id, ...system }),
      ).rejects.toSatisfy(failsWith(/kept for accounting/))
      await expect(harness.payload.delete({ collection: 'jobs', id: jobs.brewA.id, ...system })).rejects.toSatisfy(failsWith(/kept for accounting/))
      await expect(harness.payload.delete({ collection: 'tenants', id: harness.tenantA.id, ...system })).rejects.toSatisfy(failsWith(/kept for accounting/))
    })
  })
})
