import { createPayloadRequest, type CollectionConfig, type Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { superAdminAccess, type MissionControlUser } from './access'
import { addOnCollection } from './add-ons'
import {
  accountCheckoutEndpoints,
  approvePurchase,
  checkoutJob,
  CheckoutError,
  declinePurchase,
  previewCheckout,
  type CheckoutInput,
} from './checkout'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationField, organisationRoleField, organisationsCollection } from './collections/organisations'
import { couponCollection } from './coupons'
import {
  balanceFor,
  creditLedgerCollection,
  grantCredits,
  refundCreditOnCancel,
  refuseDeleteWhileInCreditLedger,
} from './credits'
import { orderCollection, refuseDeleteWhileOrdered } from './orders'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { taxonomyCollections } from './taxonomies'
import { generateSiteKey } from './site-keys'
import { bootTestPayload, type TestHarness } from './test'

type User = MissionControlUser & { collection: 'users'; email: string; id: number; role: 'user' }
type Doc = Record<string, any> & { id: number }

const withHooks = (collection: CollectionConfig, hooks: { afterChange?: any[]; beforeDelete?: any[] }): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    afterChange: [...(collection.hooks?.afterChange ?? []), ...(hooks.afterChange ?? [])],
    beforeDelete: [...(hooks.beforeDelete ?? []), ...(collection.hooks?.beforeDelete ?? [])],
  },
})

/** The ledger and orders first: the harness deletes in this order, and the guards keep referenced rows. */
const collections = (): CollectionConfig[] => [
  creditLedgerCollection(),
  orderCollection(),
  withHooks(jobsCollection({ richTextDescription: false, withOrder: true }), {
    afterChange: [refundCreditOnCancel()],
    beforeDelete: [refuseDeleteWhileInCreditLedger({ field: 'job', noun: 'job' }), refuseDeleteWhileOrdered({ field: 'jobs', noun: 'job' })],
  }),
  couponCollection(),
  organisationsCollection({ mediaSlug: null }),
  planCollection(),
  addOnCollection(),
  locationsCollection({ requireTenant: true }),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: superAdminAccess, read: superAdminAccess },
  fields: [
    { name: 'label', type: 'text', required: true },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'timezone', type: 'text' },
]

/** PJ-29's per-member switches, as the default purchase rights read them. */
const userFields: Field[] = [
  organisationField(),
  organisationRoleField(),
  { name: 'canBuy', type: 'checkbox' },
  { name: 'useCredits', type: 'checkbox' },
]

const DAY = 24 * 60 * 60 * 1000

describe('checkout integration', () => {
  let harness: TestHarness
  let payload: TestHarness['payload']
  const system = { overrideAccess: true } as const
  const users: Record<string, User> = {}
  const orgs: Record<string, Doc> = {}
  const plans: Record<string, Doc> = {}
  let enhanced: Doc
  let category: Doc
  let otherCategory: Doc
  let siteKeyA = ''

  const makeUser = async (label: string, tenants: User['tenants'], extra: Record<string, unknown> = {}): Promise<User> => {
    const doc = (await payload.create({
      collection: 'users',
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
        ...extra,
      },
      ...system,
    })) as Doc
    return { collection: 'users', email: doc.email, id: doc.id, role: 'user', tenants, ...extra } as User
  }

  const org = async (tenant: number, name: string): Promise<Doc> =>
    (await payload.create({
      collection: 'organisations',
      data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, tenant },
      ...system,
    })) as Doc

  const job = async (organisation: Doc, extra: Record<string, unknown> = {}): Promise<Doc> =>
    (await payload.create({
      collection: 'jobs',
      data: {
        categories: [category.id],
        organisation: organisation.id,
        status: 'draft',
        tenant: organisation.tenant,
        title: `Job ${Math.random().toString(36).slice(2, 10)}`,
        ...extra,
      },
      ...system,
    })) as Doc

  const reqFor = (user: null | User) => createPayloadRequest({ payload, user: user as never })

  const checkout = async (user: null | User, input: Partial<CheckoutInput> & { jobId: number }, tenantID = harness.tenantA.id) =>
    checkoutJob({
      input: { addOnIds: [], closeDate: null, couponCode: null, planId: plans.regular.id, useCredit: false, ...input },
      payload,
      req: await reqFor(user),
      tenantID,
      user,
    })

  const read = async (collection: string, id: number): Promise<Doc> =>
    (await payload.findByID({ collection: collection as never, depth: 0, id, ...system })) as Doc

  const ordersOf = async (jobID: number): Promise<Doc[]> =>
    (await payload.find({ collection: 'orders', depth: 0, pagination: false, where: { jobs: { in: [jobID] } }, ...system })).docs as Doc[]

  const ledger = async (organisation: Doc): Promise<Doc[]> =>
    (
      await payload.find({
        collection: 'credit-ledger',
        depth: 0,
        pagination: false,
        sort: 'createdAt',
        where: { organisation: { equals: organisation.id } },
        ...system,
      })
    ).docs as Doc[]

  const refused = (code: string) => (error: unknown) => error instanceof CheckoutError && error.code === code

  /** A credit the organisation already holds, from a paid pack order. */
  const giveCredits = async (organisation: Doc, credits: number): Promise<void> => {
    const order = (await payload.create({
      collection: 'orders',
      data: {
        currency: 'VUV',
        discount: 0,
        organisation: organisation.id,
        paymentMethod: 'invoice',
        paymentProvider: 'invoice',
        status: 'paid',
        subtotal: 1,
        tax: 0,
        tenant: organisation.tenant,
        total: 1,
      },
      ...system,
    })) as Doc
    await grantCredits({ credits, order: order.id, payload })
  }

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      globalCollections: [SiteKeys],
      tenantData: (which) => (which === 'A' ? { currency: 'VUV', timezone: 'Pacific/Efate' } : { currency: 'NZD', timezone: 'Pacific/Auckland' }),
      tenantFields,
      tenantHooks: {
        beforeDelete: [
          refuseDeleteWhileOrdered({ field: 'tenant', noun: 'tenant' }),
          refuseDeleteWhileInCreditLedger({ field: 'tenant', noun: 'tenant' }),
        ],
      },
      userFields,
    })
    payload = harness.payload
    const { tenantA, tenantB } = harness

    orgs.brew = await org(tenantA.id, 'Brew')
    orgs.bank = await org(tenantA.id, 'Bank')
    orgs.shop = await org(tenantB.id, 'Shop')

    const employer = (tenant: number): User['tenants'] => [{ role: 'employer', tenant }]
    users.owner = await makeUser('owner', employer(tenantA.id), { organisation: orgs.brew.id, organisationRole: 'owner' })
    users.member = await makeUser('member', employer(tenantA.id), { organisation: orgs.brew.id, organisationRole: 'member' })
    users.buyer = await makeUser('buyer', employer(tenantA.id), { canBuy: true, organisation: orgs.brew.id, organisationRole: 'member' })
    users.noCredits = await makeUser('no-credits', employer(tenantA.id), {
      organisation: orgs.brew.id,
      organisationRole: 'member',
      useCredits: false,
    })
    users.stranger = await makeUser('stranger', employer(tenantA.id), { organisation: orgs.bank.id, organisationRole: 'owner' })
    users.ownerB = await makeUser('owner-b', employer(tenantB.id), { organisation: orgs.shop.id, organisationRole: 'owner' })
    users.seeker = await makeUser('seeker', [{ role: 'seeker', tenant: tenantA.id }], { organisation: orgs.brew.id })

    category = (await payload.create({ collection: 'job-categories', data: { name: 'Tourism', slug: 'tourism', tenant: tenantA.id }, ...system })) as Doc
    otherCategory = (await payload.create({ collection: 'job-categories', data: { name: 'Finance', slug: 'finance', tenant: tenantA.id }, ...system })) as Doc

    const plan = async (tenant: number, data: Record<string, unknown>) =>
      (await payload.create({ collection: 'plans', data: { durationDays: 45, jobCredits: 1, tenant, ...data }, ...system })) as Doc
    plans.regular = await plan(tenantA.id, { key: 'regular-listing', name: 'Regular', price: 3900 })
    plans.pack = await plan(tenantA.id, { jobCredits: 5, key: 'job-pack-5', name: '5 Job Pack', price: 17500 })
    plans.free = await plan(tenantA.id, { key: 'volunteer', name: 'Volunteer', price: 0 })
    plans.finance = await plan(tenantA.id, { allowedJobCategories: [otherCategory.id], key: 'finance-only', name: 'Finance only', price: 1000 })
    plans.archived = await plan(tenantA.id, { key: 'old', name: 'Old', price: 100, status: 'archived' })
    plans.b = await plan(tenantB.id, { key: 'regular-listing', name: 'Regular', price: 5000 })

    enhanced = (await payload.create({
      collection: 'add-ons',
      data: { durationDays: 30, key: 'enhanced', name: 'Enhanced', placement: 'featured-in-listings', price: 2000, tenant: tenantA.id },
      ...system,
    })) as Doc
    await payload.create({ collection: 'coupons', data: { amount: 1900, code: 'LINKPS', discountType: 'flat', tenant: tenantA.id }, ...system })
    await payload.create({ collection: 'coupons', data: { amount: 500, code: 'ONCE', discountType: 'flat', maxUses: 1, tenant: tenantA.id }, ...system })
    await payload.create({ collection: 'coupons', data: { active: false, amount: 500, code: 'OLD', discountType: 'flat', tenant: tenantA.id }, ...system })
    await payload.create({ collection: 'coupons', data: { amount: 500, code: 'BONLY', discountType: 'flat', tenant: tenantB.id }, ...system })

    const { key, keyHash } = await generateSiteKey()
    await payload.create({ collection: 'site-keys', data: { keyHash, label: 'A', tenant: tenantA.id }, ...system })
    siteKeyA = key
  }, 120_000)

  afterAll(async () => {
    await harness?.destroy()
  })

  describe('pricing and orders', () => {
    it('prices the plan, add-ons and coupon on the server and invoices one order @S-151', async () => {
      const listing = await job(orgs.brew)
      const result = await checkout(users.owner, { addOnIds: [enhanced.id], couponCode: ' linkps ', jobId: listing.id })

      expect(result.created).toBe(true)
      expect(result.waitingForPurchase).toBe(false)
      // 3900 + 2000 − 1900, all from the database; VUV has no minor units.
      expect(result.order).toMatchObject({
        currency: 'VUV',
        discount: 1900,
        paymentMethod: 'invoice',
        paymentProvider: 'invoice',
        reference: `INV-${result.order.id}`,
        status: 'invoiced',
        subtotal: 5900,
        tax: 0,
        total: 4000,
      })

      const order = await read('orders', result.order.id as number)
      expect(order.organisation).toBe(orgs.brew.id)
      expect(order.couponCode).toBe('LINKPS')
      expect(order.quote.version).toBe(1)
      expect(order.createdBy).toMatchObject({ value: users.owner.id })
      expect(order.log.map((entry: Doc) => entry.event)).toEqual(['created', 'status'])

      const after = await read('jobs', listing.id)
      expect(after).toMatchObject({ order: order.id, plan: plans.regular.id, status: 'pending' })
      const coupon = (await payload.find({ collection: 'coupons', where: { code: { equals: 'LINKPS' } }, ...system })).docs[0] as Doc
      expect(coupon.useCount).toBe(1)
    })

    it('ignores any amount the client sends; the price comes from the plan @S-151', async () => {
      const listing = await job(orgs.brew)
      const result = await checkout(users.owner, { jobId: listing.id, total: 1, price: 1 } as never)
      expect(result.order.total).toBe(3900)
    })

    it('creates one order however often the same checkout is submitted, even at once @S-151', async () => {
      const listing = await job(orgs.brew)
      const results = await Promise.all([1, 2, 3].map(() => checkout(users.owner, { jobId: listing.id })))

      expect(results.filter((result) => result.created)).toHaveLength(1)
      expect(new Set(results.map((result) => result.order.id)).size).toBe(1)
      expect(await ordersOf(listing.id)).toHaveLength(1)

      const again = await checkout(users.owner, { jobId: listing.id })
      expect(again).toMatchObject({ created: false, order: { id: results[0].order.id, status: 'invoiced' } })
    })

    it('refuses a different checkout for a job whose order is still open, and allows one after it is cancelled @S-151', async () => {
      const listing = await job(orgs.brew)
      const first = await checkout(users.owner, { jobId: listing.id })
      await expect(checkout(users.owner, { addOnIds: [enhanced.id], jobId: listing.id })).rejects.toSatisfy(refused('already_checked_out'))

      await payload.update({ collection: 'orders', data: { status: 'cancelled' }, id: first.order.id, ...system })
      const second = await checkout(users.owner, { addOnIds: [enhanced.id], jobId: listing.id })
      expect(second.created).toBe(true)
      expect(second.order.id).not.toBe(first.order.id)
      expect(second.order.total).toBe(5900)
    })

    it('makes a zero total a free order, paid at once @S-151', async () => {
      const listing = await job(orgs.brew)
      const result = await checkout(users.member, { jobId: listing.id, planId: plans.free.id })
      expect(result.order).toMatchObject({ paymentMethod: 'free', paymentProvider: null, status: 'paid', total: 0 })
      expect((await read('orders', result.order.id as number)).paidAt).toBeTruthy()
    })

    it('applies the plan’s job restrictions and refuses archived plans @S-151', async () => {
      const listing = await job(orgs.brew)
      await expect(checkout(users.owner, { jobId: listing.id, planId: plans.finance.id })).rejects.toSatisfy(
        (error) => error instanceof CheckoutError && error.code === 'pricing_error' && error.detail?.pricing === 'job_not_allowed',
      )
      await expect(checkout(users.owner, { jobId: listing.id, planId: plans.archived.id })).rejects.toSatisfy(
        (error) => error instanceof CheckoutError && error.detail?.pricing === 'plan_archived',
      )
      expect(await ordersOf(listing.id)).toHaveLength(0)
    })

    it('refuses a coupon that is unknown, inactive, used up or from another tenant, and charges nothing @S-037', async () => {
      const listing = await job(orgs.brew)
      for (const couponCode of ['NOPE', 'OLD', 'BONLY']) {
        await expect(checkout(users.owner, { couponCode, jobId: listing.id })).rejects.toSatisfy(refused('coupon_invalid'))
      }
      await checkout(users.owner, { couponCode: 'ONCE', jobId: (await job(orgs.brew)).id })
      await expect(checkout(users.owner, { couponCode: 'ONCE', jobId: listing.id })).rejects.toSatisfy(
        (error) => error instanceof CheckoutError && error.code === 'coupon_invalid' && error.detail?.reason === 'used-up',
      )
      expect(await ordersOf(listing.id)).toHaveLength(0)
    })

    it('never lets a limited coupon be used past its limit by simultaneous checkouts @S-037', async () => {
      await payload.create({ collection: 'coupons', data: { amount: 100, code: 'RACE', discountType: 'flat', maxUses: 1, tenant: harness.tenantA.id }, ...system })
      const brewJob = await job(orgs.brew)
      const bankJob = await job(orgs.bank)
      const settled = await Promise.allSettled([
        checkout(users.owner, { couponCode: 'RACE', jobId: brewJob.id }),
        checkout(users.stranger, { couponCode: 'RACE', jobId: bankJob.id }),
      ])
      expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
      const coupon = (await payload.find({ collection: 'coupons', where: { code: { equals: 'RACE' } }, ...system })).docs[0] as Doc
      expect(coupon.useCount).toBe(1)
    })

    it('previews the same price without writing anything @S-151', async () => {
      const listing = await job(orgs.brew)
      const preview = await previewCheckout({
        input: { addOnIds: [enhanced.id], closeDate: null, couponCode: 'LINKPS', jobId: listing.id, planId: plans.regular.id, useCredit: false },
        payload,
        req: await reqFor(users.member),
        tenantID: harness.tenantA.id,
        user: users.member,
      })
      expect(preview).toMatchObject({ needsApproval: true, paymentMethod: 'invoice', quote: { total: 4000 } })
      expect(await ordersOf(listing.id)).toHaveLength(0)
    })
  })

  describe('close date', () => {
    it('stores the chosen close date and refuses one past the plan’s maximum @S-031', async () => {
      const listing = await job(orgs.brew)
      const tooLate = new Date(Date.now() + 50 * DAY).toISOString().slice(0, 10)
      await expect(checkout(users.owner, { closeDate: tooLate, jobId: listing.id })).rejects.toSatisfy(refused('close_date_invalid'))
      await expect(checkout(users.owner, { closeDate: '2020-01-01', jobId: listing.id })).rejects.toSatisfy(refused('close_date_invalid'))

      const inTen = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10)
      const result = await checkout(users.owner, { closeDate: inTen, jobId: listing.id })
      // The end of that day in Vanuatu (UTC+11).
      expect(result.job.expiresAt).toBe(new Date(`${inTen}T23:59:59.999+11:00`).toISOString())

      // Publishing keeps the chosen date, which is inside the plan's 45 days.
      const published = (await payload.update({ collection: 'jobs', data: { status: 'published' }, id: listing.id, ...system })) as Doc
      expect(published.expiresAt).toBe(result.job.expiresAt)
    })

    it('runs for the plan’s full duration when no close date is chosen @S-031', async () => {
      const listing = await job(orgs.brew)
      const result = await checkout(users.owner, { jobId: listing.id })
      expect(result.job.expiresAt).toBeNull()
      const published = (await payload.update({ collection: 'jobs', data: { status: 'published' }, id: listing.id, ...system })) as Doc
      expect(Date.parse(published.expiresAt) - Date.parse(published.publishedAt)).toBe(45 * DAY)
    })
  })

  describe('credits', () => {
    it('pays a listing with a credit, recorded against its order @S-038', async () => {
      const organisation = await org(harness.tenantA.id, 'Creditco')
      const owner = await makeUser('credit-owner', [{ role: 'employer', tenant: harness.tenantA.id }], {
        organisation: organisation.id,
        organisationRole: 'owner',
      })
      await giveCredits(organisation, 2)
      const listing = await job(organisation)

      const result = await checkout(owner, { jobId: listing.id, useCredit: true })
      expect(result.order).toMatchObject({ discount: 3900, paymentMethod: 'credit', status: 'paid', total: 0 })
      expect(result.credits).toMatchObject({ balance: 1, used: 1 })
      const used = (await ledger(organisation)).filter((row) => row.reason === 'used')
      expect(used).toHaveLength(1)
      expect(used[0]).toMatchObject({ delta: -1, job: listing.id, order: result.order.id })

      // A repeat spends nothing more.
      expect(await checkout(owner, { jobId: listing.id, useCredit: true })).toMatchObject({ created: false })
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(1)
    })

    it('uses the credit for the plan and invoices the add-ons @S-038', async () => {
      const organisation = await org(harness.tenantA.id, 'Mixco')
      const owner = await makeUser('mix-owner', [{ role: 'employer', tenant: harness.tenantA.id }], {
        organisation: organisation.id,
        organisationRole: 'owner',
      })
      await giveCredits(organisation, 1)
      const result = await checkout(owner, { addOnIds: [enhanced.id], jobId: (await job(organisation)).id, useCredit: true })
      expect(result.order).toMatchObject({ paymentMethod: 'invoice', status: 'invoiced', total: 2000 })
      expect(result.credits).toMatchObject({ balance: 0, used: 1 })
    })

    it('charges cash when the organisation has no credit, and refuses a member who may not use credits @S-038', async () => {
      const organisation = await org(harness.tenantA.id, 'Emptyco')
      const owner = await makeUser('empty-owner', [{ role: 'employer', tenant: harness.tenantA.id }], {
        organisation: organisation.id,
        organisationRole: 'owner',
      })
      const result = await checkout(owner, { jobId: (await job(organisation)).id, useCredit: true })
      expect(result.order).toMatchObject({ paymentMethod: 'invoice', total: 3900 })

      await expect(checkout(users.noCredits, { jobId: (await job(orgs.brew)).id, useCredit: true })).rejects.toSatisfy(refused('forbidden'))
    })

    it('grants a pack’s credits through the ledger and uses one for the job @S-153', async () => {
      const organisation = await org(harness.tenantA.id, 'Packco')
      const owner = await makeUser('pack-owner', [{ role: 'employer', tenant: harness.tenantA.id }], {
        organisation: organisation.id,
        organisationRole: 'owner',
      })
      const listing = await job(organisation)
      const result = await checkout(owner, { jobId: listing.id, planId: plans.pack.id })

      expect(result.order).toMatchObject({ paymentMethod: 'invoice', status: 'invoiced', total: 17500 })
      expect(result.credits).toEqual({ balance: 4, granted: 5, used: 1 })
      expect((await ledger(organisation)).map((row) => [row.reason, row.delta, row.order])).toEqual([
        ['bought', 5, result.order.id],
        ['used', -1, result.order.id],
      ])

      // The next job is paid from the pack.
      const next = await checkout(owner, { jobId: (await job(organisation)).id, useCredit: true })
      expect(next.order.paymentMethod).toBe('credit')
      expect(next.credits.balance).toBe(3)
    })
  })

  describe('purchase rights', () => {
    it('lets a member who may buy check out directly @S-152', async () => {
      const result = await checkout(users.buyer, { jobId: (await job(orgs.brew)).id })
      expect(result).toMatchObject({ order: { status: 'invoiced' }, waitingForPurchase: false })
    })

    it('holds a member’s purchase for the owner, who approves it once @S-152', async () => {
      const listing = await job(orgs.brew)
      const result = await checkout(users.member, { couponCode: 'LINKPS', jobId: listing.id })
      expect(result).toMatchObject({ order: { status: 'waiting_for_purchase', total: 2000 }, waitingForPurchase: true })
      expect((await read('jobs', listing.id)).status).toBe('pending')

      const args = { orderId: result.order.id, payload, tenantID: harness.tenantA.id }
      await expect(approvePurchase({ ...args, req: await reqFor(users.member), user: users.member })).rejects.toSatisfy(refused('forbidden'))
      await expect(approvePurchase({ ...args, req: await reqFor(users.stranger), user: users.stranger })).rejects.toSatisfy(refused('not_found'))

      const coupon = async () => ((await payload.find({ collection: 'coupons', where: { code: { equals: 'LINKPS' } }, ...system })).docs[0] as Doc).useCount
      const usesBefore = await coupon()
      const approved = await approvePurchase({ ...args, req: await reqFor(users.owner), user: users.owner })
      expect(approved).toMatchObject({ created: true, order: { status: 'invoiced', total: 2000 } })
      expect(await coupon()).toBe(usesBefore + 1)

      const again = await approvePurchase({ ...args, req: await reqFor(users.owner), user: users.owner })
      expect(again.created).toBe(false)
      expect(await coupon()).toBe(usesBefore + 1)

      const order = await read('orders', result.order.id as number)
      expect(order.log.map((entry: Doc) => [entry.to, entry.actor])).toEqual([
        ['waiting_for_purchase', 'system'],
        ['pending', 'system'],
        ['invoiced', 'system'],
      ])
    })

    it('lets the owner decline a purchase, after which the job can be checked out again @S-152', async () => {
      const listing = await job(orgs.brew)
      const held = await checkout(users.member, { jobId: listing.id })
      const declined = await declinePurchase({ orderId: held.order.id, payload, req: await reqFor(users.owner), tenantID: harness.tenantA.id, user: users.owner })
      expect(declined.status).toBe('cancelled')
      await expect(
        approvePurchase({ orderId: held.order.id, payload, req: await reqFor(users.owner), tenantID: harness.tenantA.id, user: users.owner }),
      ).rejects.toSatisfy(refused('order_not_waiting'))

      const bought = await checkout(users.owner, { jobId: listing.id })
      expect(bought.order.status).toBe('invoiced')
    })

    it('lets a member pay with a credit without buy rights @S-152', async () => {
      await giveCredits(orgs.brew, 1)
      const result = await checkout(users.member, { jobId: (await job(orgs.brew)).id, useCredit: true })
      expect(result).toMatchObject({ order: { paymentMethod: 'credit', status: 'paid' }, waitingForPurchase: false })
    })
  })

  describe('access and tenancy', () => {
    it('hides another organisation’s or tenant’s job, and refuses seekers @S-151', async () => {
      const listing = await job(orgs.brew)
      await expect(checkout(users.stranger, { jobId: listing.id })).rejects.toSatisfy(refused('not_found'))
      await expect(checkout(users.ownerB, { jobId: listing.id, planId: plans.b.id }, harness.tenantB.id)).rejects.toSatisfy(refused('not_found'))
      await expect(checkout(users.seeker, { jobId: listing.id })).rejects.toSatisfy(refused('not_found'))
      // The right organisation, but through the other tenant's site.
      await expect(checkout(users.owner, { jobId: listing.id }, harness.tenantB.id)).rejects.toSatisfy(refused('not_found'))
      expect(await ordersOf(listing.id)).toHaveLength(0)
    })

    it('refuses another tenant’s plan and add-on @S-151', async () => {
      const listing = await job(orgs.brew)
      await expect(checkout(users.owner, { jobId: listing.id, planId: plans.b.id })).rejects.toSatisfy(refused('not_found'))
    })

    it('lets a site manager check out any organisation’s job in their tenant, but not another tenant’s @S-151', async () => {
      const listing = await job(orgs.bank)
      const result = await checkout(harness.tenantAdminA as never, { jobId: listing.id })
      expect(result.order.status).toBe('invoiced')
      expect((await read('orders', result.order.id as number)).organisation).toBe(orgs.bank.id)

      const shopJob = await job(orgs.shop, { categories: [] })
      await expect(checkout(harness.tenantAdminA as never, { jobId: shopJob.id, planId: plans.b.id }, harness.tenantB.id)).rejects.toSatisfy(
        refused('not_found'),
      )
    })

    it('refuses jobs that are no longer drafts or pending @S-151', async () => {
      const live = await job(orgs.brew, { status: 'published' })
      await expect(checkout(users.owner, { jobId: live.id })).rejects.toSatisfy(refused('job_not_checkoutable'))
    })
  })

  describe('account endpoints', () => {
    const endpoints = accountCheckoutEndpoints()
    const endpoint = (path: string) => endpoints.find((entry) => entry.path === `/:slug/account/${path}`)!

    const call = async (path: string, body: unknown, { key = siteKeyA, routeParams = {}, user = users.owner as null | User } = {}) => {
      const headers = new Headers({ 'content-type': 'application/json' })
      if (key) headers.set('x-site-key', key)
      const req = await createPayloadRequest({
        payload,
        req: { headers, json: async () => body, routeParams: { slug: harness.tenantA.slug, ...routeParams } } as never,
        user: user as never,
      })
      const response = (await endpoint(path).handler(req)) as Response
      return { body: (await response.json()) as Record<string, any>, status: response.status }
    }

    it('checks out with a site key and a signed-in employer, and repeats safely @S-151', async () => {
      const listing = await job(orgs.brew)
      const body = { addOnIds: [enhanced.id], jobId: listing.id, planId: plans.regular.id }

      const quoted = await call('checkout/quote', body)
      expect(quoted).toMatchObject({ body: { paymentMethod: 'invoice', quote: { total: 5900 } }, status: 200 })

      const first = await call('checkout', body)
      expect(first).toMatchObject({ body: { created: true, order: { status: 'invoiced', total: 5900 } }, status: 201 })
      const second = await call('checkout', body)
      expect(second).toMatchObject({ body: { created: false, order: { id: first.body.order.id } }, status: 200 })
    })

    it('refuses a missing site key, a signed-out caller and a bad body @S-151', async () => {
      const listing = await job(orgs.brew)
      const body = { jobId: listing.id, planId: plans.regular.id }
      expect((await call('checkout', body, { key: '' })).status).toBe(401)
      expect((await call('checkout', body, { user: null })).body.error.code).toBe('not_authenticated')
      expect((await call('checkout', { jobId: listing.id })).body.error.code).toBe('invalid_request')
      expect((await call('checkout', body, { user: users.stranger })).status).toBe(404)
    })

    it('lets the owner approve a purchase request through the endpoint @S-152', async () => {
      const listing = await job(orgs.brew)
      const held = await call('checkout', { jobId: listing.id, planId: plans.regular.id }, { user: users.member })
      expect(held.body.waitingForPurchase).toBe(true)

      const byMember = await call('orders/:id/approve', {}, { routeParams: { id: String(held.body.order.id) }, user: users.member })
      expect(byMember.status).toBe(403)
      const approved = await call('orders/:id/approve', {}, { routeParams: { id: String(held.body.order.id) } })
      expect(approved).toMatchObject({ body: { order: { status: 'invoiced' } }, status: 200 })
    })
  })
})
