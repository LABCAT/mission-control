import { type CollectionConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationField, organisationsCollection } from './collections/organisations'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { taxonomyCollections } from './taxonomies'
import { tenantPackCreditsField } from './credit-settings'
import {
  balanceFor,
  creditLedgerCollection,
  grantCredits,
  grantPackCreditsOnPaid,
  refuseDeleteWhileInCreditLedger,
} from './credits'
import { orderCollection } from './orders'
import { bootTestPayload, type TestHarness } from './test'

type Doc = Record<string, any> & { id: number }

const withHooks = (collection: CollectionConfig, hooks: { afterChange?: any[] }): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    afterChange: [...(collection.hooks?.afterChange ?? []), ...(hooks.afterChange ?? [])],
  },
})

/** The ledger first: the harness deletes in this order, and the guards keep referenced rows. */
const collections = (): CollectionConfig[] => [
  creditLedgerCollection(),
  withHooks(orderCollection({ couponsEnabled: false }), { afterChange: [grantPackCreditsOnPaid()] }),
  withHooks(jobsCollection({ richTextDescription: false, withOrder: true }), {}),
  organisationsCollection({ mediaSlug: null }),
  planCollection(),
  addOnCollection(),
  locationsCollection({ requireTenant: true }),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

/**
 * When a pack's credits become usable (PJ-120), per tenant: `on_payment` (the default and the old
 * site's rule) or `on_invoice`. Tenant A never sets the option; tenant B grants on invoice.
 */
describe('pack credit modes', () => {
  let harness: TestHarness
  let payload: TestHarness['payload']
  const system = { overrideAccess: true } as const
  const orgs: Record<string, Doc> = {}

  const org = async (tenant: number, name: string): Promise<Doc> =>
    (await payload.create({
      collection: 'organisations',
      data: { name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, tenant },
      ...system,
    })) as Doc

  const job = async (organisation: Doc): Promise<Doc> =>
    (await payload.create({
      collection: 'jobs',
      data: { organisation: organisation.id, status: 'pending', tenant: organisation.tenant, title: `Job ${Math.random().toString(36).slice(2, 10)}` },
      ...system,
    })) as Doc

  /** A pack order granting 5 credits, with the entitlement checkout stores on its quote. */
  const packOrder = async (organisation: Doc, listing: Doc, status: string, planCredits = 5): Promise<Doc> => {
    const order = (await payload.create({
      collection: 'orders',
      data: {
        currency: 'VUV',
        discount: 0,
        jobs: [listing.id],
        organisation: organisation.id,
        paymentMethod: 'invoice',
        paymentProvider: 'invoice',
        status,
        subtotal: 17500,
        tax: 0,
        tenant: organisation.tenant,
        total: 17500,
      },
      ...system,
    })) as Doc
    // The quote snapshot is checked on create; write the entitlement the way a stored one carries
    // it, without re-pricing a quote here.
    await payload.db.updateOne({
      collection: 'orders',
      data: { quote: { entitlements: { jobCreditsGranted: planCredits }, plan: { jobCredits: planCredits } } },
      id: order.id,
    })
    await payload.update({ collection: 'jobs', data: { order: order.id }, id: listing.id, ...system })
    return order
  }

  const rows = async (organisation: Doc): Promise<Doc[]> =>
    (
      await payload.find({
        collection: 'credit-ledger',
        depth: 0,
        overrideAccess: true,
        pagination: false,
        sort: 'createdAt',
        where: { organisation: { equals: organisation.id } },
      })
    ).docs as Doc[]

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      // Tenant B grants on invoice. Tenant A leaves it unset, so the default (on payment) applies.
      tenantData: (which) => (which === 'B' ? { packCreditsUsableAt: 'on_invoice' } : {}),
      tenantFields: [tenantPackCreditsField()],
      tenantHooks: { beforeDelete: [refuseDeleteWhileInCreditLedger({ field: 'tenant', noun: 'tenant' })] },
      userFields: [organisationField()],
    })
    payload = harness.payload

    orgs.waitA = await org(harness.tenantA.id, 'Wait')
    orgs.invoiceA = await org(harness.tenantA.id, 'Invoice')
    orgs.earlyB = await org(harness.tenantB.id, 'Early')
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  describe('on payment (the default)', () => {
    it('grants nothing while the order is only invoiced @S-210', async () => {
      const listing = await job(orgs.invoiceA)
      const order = await packOrder(orgs.invoiceA, listing, 'invoiced')

      expect(await rows(orgs.invoiceA)).toEqual([])
      await expect(grantCredits({ order: order.id, payload })).rejects.toThrow(/when the order is paid/)
      expect(await balanceFor({ organisation: orgs.invoiceA.id, payload })).toBe(0)
      // Only the job waits for payment; the pack's credits are not spent on it yet.
      expect((await payload.findByID({ collection: 'jobs', depth: 0, id: listing.id, ...system })) as Doc).toMatchObject({
        status: 'pending',
      })
    })

    it('grants the pack and uses one for the job when the order becomes paid @S-210', async () => {
      const listing = await job(orgs.invoiceA)
      const order = await packOrder(orgs.invoiceA, listing, 'invoiced')

      await payload.update({ collection: 'orders', data: { status: 'paid' }, id: order.id, ...system })

      expect((await rows(orgs.invoiceA)).map((row) => [row.reason, row.delta, row.job, row.order])).toEqual([
        ['bought', 5, null, order.id],
        ['used', -1, listing.id, order.id],
      ])
      expect(await balanceFor({ organisation: orgs.invoiceA.id, payload })).toBe(4)
    })

    it('grants once however often the order is marked paid @S-210', async () => {
      const listing = await job(orgs.invoiceA)
      const order = await packOrder(orgs.invoiceA, listing, 'pending')

      await payload.update({ collection: 'orders', data: { status: 'invoiced' }, id: order.id, ...system })
      await payload.update({ collection: 'orders', data: { status: 'paid' }, id: order.id, ...system })
      const balance = await balanceFor({ organisation: orgs.invoiceA.id, payload })
      // A repeat of grantCredits, as a retried payment sync would call it, adds nothing.
      await payload.update({ collection: 'orders', data: { status: 'paid' }, id: order.id, ...system })
      expect(await grantCredits({ order: order.id, payload })).toMatchObject({ created: false })

      expect(await balanceFor({ organisation: orgs.invoiceA.id, payload })).toBe(balance)
      expect((await rows(orgs.invoiceA)).filter((row) => row.order === order.id).map((row) => row.reason)).toEqual([
        'bought',
        'used',
      ])
    })

    it('grants nothing for an order cancelled or failed before payment @S-210', async () => {
      const listing = await job(orgs.waitA)
      const order = await packOrder(orgs.waitA, listing, 'pending')

      await payload.update({ collection: 'orders', data: { status: 'cancelled' }, id: order.id, ...system })

      expect(await rows(orgs.waitA)).toEqual([])
      expect(await balanceFor({ organisation: orgs.waitA.id, payload })).toBe(0)
    })

    it('grants nothing extra for a paid single listing, which is not a pack @S-210', async () => {
      const listing = await job(orgs.waitA)
      // A listing plan includes the one listing it sells: jobCredits 1, and no pack to bank.
      const order = await packOrder(orgs.waitA, listing, 'invoiced', 1)

      await payload.update({ collection: 'orders', data: { status: 'paid' }, id: order.id, ...system })

      expect(await rows(orgs.waitA)).toEqual([])
      expect(await balanceFor({ organisation: orgs.waitA.id, payload })).toBe(0)
    })
  })

  describe('on invoice', () => {
    it('grants the pack as soon as the order is invoiced @S-211', async () => {
      const listing = await job(orgs.earlyB)
      const order = await packOrder(orgs.earlyB, listing, 'invoiced')

      // The grant checkout makes once the invoice is sent: allowed here, refused below for A.
      expect(await grantCredits({ order: order.id, payload })).toMatchObject({ balance: 5, created: true })
      expect((await rows(orgs.earlyB)).map((row) => [row.reason, row.delta, row.order])).toEqual([['bought', 5, order.id]])

      // Paying it later grants nothing more; the job still takes its one credit, as at checkout.
      await payload.update({ collection: 'orders', data: { status: 'paid' }, id: order.id, ...system })
      expect((await rows(orgs.earlyB)).map((row) => [row.reason, row.delta, row.job])).toEqual([
        ['bought', 5, null],
        ['used', -1, listing.id],
      ])
      expect(await balanceFor({ organisation: orgs.earlyB.id, payload })).toBe(4)
    })

    it('keeps each tenant on its own rule and its ledger to itself @S-211', async () => {
      const waitsA = await org(harness.tenantA.id, 'Rule-a')
      const grantsB = await org(harness.tenantB.id, 'Rule-b')
      const orderA = await packOrder(waitsA, await job(waitsA), 'invoiced')
      const orderB = await packOrder(grantsB, await job(grantsB), 'invoiced')

      await expect(grantCredits({ order: orderA.id, payload })).rejects.toThrow(/when the order is paid/)
      expect(await balanceFor({ organisation: waitsA.id, payload })).toBe(0)
      expect(await rows(waitsA)).toEqual([])

      await grantCredits({ order: orderB.id, payload })
      expect(await balanceFor({ organisation: grantsB.id, payload })).toBe(5)
      expect((await rows(grantsB)).map((row) => row.tenant)).toEqual([harness.tenantB.id])
    })
  })
})
