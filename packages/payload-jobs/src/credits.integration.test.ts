import { createPayloadRequest, type CollectionConfig } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { MissionControlUser } from './access'
import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationField, organisationsCollection } from './collections/organisations'
import {
  adjustCredits,
  balanceFor,
  consumeCredit,
  CREDIT_LEDGER_SLUG,
  creditLedgerCollection,
  CreditLedgerError,
  grantCredits,
  organisationHistoryEndpoint,
  recordOpeningCredits,
  refundCredit,
  refundCreditOnCancel,
  refuseDeleteWhileInCreditLedger,
} from './credits'
import { orderCollection } from './orders'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'

type User = MissionControlUser & { collection: 'users'; email: string; id: number; role: 'user' }
type Doc = Record<string, any> & { id: number }

const failsWith =
  (pattern: RegExp) =>
  (error: unknown): boolean => {
    const { data, message } = error as { data?: { errors?: { message?: string }[] }; message?: string }
    return pattern.test([message, ...(data?.errors ?? []).map((entry) => entry.message)].join(' | '))
  }

const withHooks = (
  collection: CollectionConfig,
  hooks: { afterChange?: any[]; beforeDelete?: any[] },
  endpoints: any[] = [],
): CollectionConfig => ({
  ...collection,
  endpoints: [...(Array.isArray(collection.endpoints) ? collection.endpoints : []), ...endpoints],
  hooks: {
    ...collection.hooks,
    afterChange: [...(collection.hooks?.afterChange ?? []), ...(hooks.afterChange ?? [])],
    beforeDelete: [...(hooks.beforeDelete ?? []), ...(collection.hooks?.beforeDelete ?? [])],
  },
})

const historyEndpoint = organisationHistoryEndpoint()

/** The ledger first: the harness deletes in this order, and the guards keep referenced documents. */
const collections = (): CollectionConfig[] => [
  creditLedgerCollection(),
  orderCollection({ couponsEnabled: false }),
  withHooks(jobsCollection({ richTextDescription: false, withOrder: true }), {
    afterChange: [refundCreditOnCancel()],
    beforeDelete: [refuseDeleteWhileInCreditLedger({ field: 'job', noun: 'job' })],
  }),
  withHooks(
    organisationsCollection({ mediaSlug: null }),
    { beforeDelete: [refuseDeleteWhileInCreditLedger({ field: 'organisation', noun: 'organisation' })] },
    [historyEndpoint],
  ),
  planCollection(),
  addOnCollection(),
  locationsCollection({ requireTenant: true }),
  ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
]

describe('credit ledger integration', () => {
  let harness: TestHarness
  const users: Record<string, User> = {}
  const orgs: Record<string, Doc> = {}
  const system = { overrideAccess: true } as const
  let payload: TestHarness['payload']

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
      data: { organisation: organisation.id, status: 'pending', tenant: organisation.tenant, title: `Job ${Math.random().toString(36).slice(2, 10)}`, ...extra },
      ...system,
    })) as Doc

  /** A paid pack order granting `credits`, with the quote's entitlement as checkout stores it. */
  const packOrder = async (organisation: Doc, credits = 5, status = 'paid'): Promise<Doc> =>
    (await payload.create({
      collection: 'orders',
      data: {
        currency: 'VUV',
        discount: 0,
        organisation: organisation.id,
        paymentMethod: 'invoice',
        paymentProvider: 'invoice',
        quote: undefined,
        status,
        subtotal: 17500,
        tax: 0,
        tenant: organisation.tenant,
        total: 17500,
      },
      ...system,
    }).then(async (order) => {
      // The quote snapshot is checked against the order on create; set the entitlement the way a
      // stored snapshot carries it, without re-pricing here.
      await payload.db.updateOne({
        collection: 'orders',
        data: { quote: { entitlements: { jobCreditsGranted: credits } } },
        id: order.id,
      })
      return order
    })) as Doc

  const rows = async (organisation: Doc): Promise<Doc[]> =>
    (
      await payload.find({
        collection: CREDIT_LEDGER_SLUG,
        depth: 0,
        overrideAccess: true,
        pagination: false,
        sort: 'createdAt',
        where: { organisation: { equals: organisation.id } },
      })
    ).docs as Doc[]

  /** A fresh request per call, so concurrent calls get transactions of their own. */
  const fresh = () => createPayloadRequest({ payload })

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      tenantHooks: { beforeDelete: [refuseDeleteWhileInCreditLedger({ field: 'tenant', noun: 'tenant' })] },
      userFields: [organisationField()],
    })
    payload = harness.payload

    orgs.brewA = await org(harness.tenantA.id, 'Brew')
    orgs.bankA = await org(harness.tenantA.id, 'Bank')
    orgs.shopB = await org(harness.tenantB.id, 'Shop')

    users.memberBrew = await makeUser('member-brew', [{ role: 'employer', tenant: harness.tenantA.id }], { organisation: orgs.brewA.id })
    users.memberBank = await makeUser('member-bank', [{ role: 'employer', tenant: harness.tenantA.id }], { organisation: orgs.bankA.id })
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: harness.tenantA.id }])
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  describe('grant, consume and refund @S-149', () => {
    it('grants an order’s credits once, however often it is called', async () => {
      const organisation = await org(harness.tenantA.id, 'Granted')
      const order = await packOrder(organisation, 5)

      const first = await grantCredits({ order: order.id, payload })
      const again = await grantCredits({ order: order.id, payload })

      expect(first).toMatchObject({ balance: 5, created: true })
      expect(again).toMatchObject({ balance: 5, created: false })
      expect(again.entry.id).toBe(first.entry.id)
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(5)
      expect((await rows(organisation)).map((row) => [row.reason, row.delta, row.actor])).toEqual([['bought', 5, 'system']])
    })

    it('refuses to grant from an order that was not sold, or a count that disagrees with its quote', async () => {
      const organisation = await org(harness.tenantA.id, 'Unsold')
      const pending = await packOrder(organisation, 5, 'pending')
      await expect(grantCredits({ order: pending.id, payload })).rejects.toThrow(/pending order grants no credits/)

      const paid = await packOrder(organisation, 5)
      await expect(grantCredits({ credits: 10, order: paid.id, payload })).rejects.toThrow(/grants 5 credits, not 10/)
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(0)
    })

    it('never lets the balance go below zero', async () => {
      const organisation = await org(harness.tenantA.id, 'Empty')
      const listing = await job(organisation)

      await expect(consumeCredit({ job: listing.id, payload })).rejects.toSatisfy(
        (error: unknown) => error instanceof CreditLedgerError && error.code === 'insufficient-credits',
      )
      await expect(
        adjustCredits({ delta: -1, note: 'Take one back', organisation: organisation.id, payload }),
      ).rejects.toSatisfy(failsWith(/Not enough credits/))
      expect(await rows(organisation)).toEqual([])
    })

    it('uses one credit per job and order, and refunds a job cancelled before publishing exactly once', async () => {
      const organisation = await org(harness.tenantA.id, 'Refund')
      await grantCredits({ order: (await packOrder(organisation, 2)).id, payload })
      const listing = await job(organisation)

      expect((await consumeCredit({ job: listing.id, payload })).balance).toBe(1)
      expect((await consumeCredit({ job: listing.id, payload })).created).toBe(false)

      // Not cancelled yet: nothing to refund.
      await expect(refundCredit({ job: listing.id, payload })).rejects.toThrow(/cancelled before it was published/)

      // Cancelling the pending job refunds it in the same transaction (the jobs hook).
      await payload.update({ collection: 'jobs', data: { status: 'cancelled' }, id: listing.id, ...system })
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(2)

      const again = await refundCredit({ job: listing.id, payload })
      expect(again.created).toBe(false)
      expect((await rows(organisation)).map((row) => `${row.reason}${row.delta}`)).toEqual(['bought2', 'used-1', 'refunded1'])
    })

    it('keeps the credit of a job that was published, and refunds nothing for a job that used none', async () => {
      const organisation = await org(harness.tenantA.id, 'Published')
      await grantCredits({ order: (await packOrder(organisation, 1)).id, payload })
      const live = await job(organisation)
      await consumeCredit({ job: live.id, payload })
      await payload.update({ collection: 'jobs', data: { status: 'published' }, id: live.id, ...system })
      await payload.update({ collection: 'jobs', data: { status: 'cancelled' }, id: live.id, ...system })
      await expect(refundCredit({ job: live.id, payload })).rejects.toThrow(/cancelled before it was published/)

      const unpaid = await job(organisation)
      await payload.update({ collection: 'jobs', data: { status: 'cancelled' }, id: unpaid.id, ...system })
      await expect(refundCredit({ job: unpaid.id, payload })).rejects.toThrow(/no unrefunded credit/)

      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(0)
    })

    it('records adjustments with a note and opening balances once per legacy record', async () => {
      const organisation = await org(harness.tenantA.id, 'Opening')
      await expect(adjustCredits({ delta: 2, note: ' ', organisation: organisation.id, payload })).rejects.toSatisfy(failsWith(/Say why/))

      const opening = await recordOpeningCredits({ credits: 4, legacyRef: 'wp-pack:77', organisation: organisation.id, payload })
      const repeat = await recordOpeningCredits({ credits: 4, legacyRef: 'wp-pack:77', organisation: organisation.id, payload })
      expect(repeat.entry.id).toBe(opening.entry.id)

      const req = await createPayloadRequest({ payload, user: harness.tenantAdminA as never })
      const adjusted = await adjustCredits({ delta: -1, idempotencyKey: 'form-1', note: 'Posted twice', organisation: organisation.id, payload, req })
      const retried = await adjustCredits({ delta: -1, idempotencyKey: 'form-1', note: 'Posted twice', organisation: organisation.id, payload, req })
      expect(retried.entry.id).toBe(adjusted.entry.id)
      expect(adjusted.balance).toBe(3)
      expect(adjusted.entry.createdBy).toMatchObject({ relationTo: 'users', value: harness.tenantAdminA.id })
      expect(adjusted.entry.note).toBe('Posted twice')
    })
  })

  describe('concurrency @S-149', () => {
    it('lets exactly as many concurrent uses through as there are credits', async () => {
      const organisation = await org(harness.tenantA.id, 'Race')
      await grantCredits({ order: (await packOrder(organisation, 3)).id, payload })
      const listings = await Promise.all(Array.from({ length: 8 }, () => job(organisation)))

      const results = await Promise.allSettled(
        listings.map(async (listing) => consumeCredit({ job: listing.id, payload, req: await fresh() })),
      )

      const won = results.filter((result) => result.status === 'fulfilled')
      const lost = results.filter((result) => result.status === 'rejected')
      expect(won).toHaveLength(3)
      expect(lost).toHaveLength(5)
      for (const result of lost) {
        expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'insufficient-credits' })
      }
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(0)
    })

    it('grants an order once and refunds a job once under concurrent calls', async () => {
      const organisation = await org(harness.tenantA.id, 'RaceOnce')
      const order = await packOrder(organisation, 4)

      const grants = await Promise.allSettled(
        Array.from({ length: 6 }, async () => grantCredits({ order: order.id, payload, req: await fresh() })),
      )
      expect(grants.every((result) => result.status === 'fulfilled')).toBe(true)
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(4)

      const listing = await job(organisation)
      await consumeCredit({ job: listing.id, payload })
      // Cancel without the hook's refund (straight to the database), then race the refunds.
      await payload.db.updateOne({ collection: 'jobs', data: { status: 'cancelled' }, id: listing.id })
      await Promise.allSettled(
        Array.from({ length: 6 }, async () => refundCredit({ job: listing.id, payload, req: await fresh() })),
      )

      const reasons = (await rows(organisation)).map((row) => row.reason)
      expect(reasons.filter((reason) => reason === 'bought')).toHaveLength(1)
      expect(reasons.filter((reason) => reason === 'refunded')).toHaveLength(1)
      expect(await balanceFor({ organisation: organisation.id, payload })).toBe(4)
    })

    it('keeps the balance at zero or more under a random mix of concurrent moves', async () => {
      const organisation = await org(harness.tenantA.id, 'Mix')
      await grantCredits({ order: (await packOrder(organisation, 2)).id, payload })
      const listings = await Promise.all(Array.from({ length: 4 }, () => job(organisation)))

      await Promise.allSettled([
        ...listings.map(async (listing) => consumeCredit({ job: listing.id, payload, req: await fresh() })),
        ...Array.from({ length: 3 }, async (_, index) =>
          adjustCredits({ delta: -1, note: `Correction ${index}`, organisation: organisation.id, payload, req: await fresh() }),
        ),
        (async () => adjustCredits({ delta: 1, note: 'Goodwill', organisation: organisation.id, payload, req: await fresh() }))(),
      ])

      // Replay the committed rows in order: the running balance never dipped below zero.
      let running = 0
      for (const row of await rows(organisation)) {
        running += row.delta
        expect(running).toBeGreaterThanOrEqual(0)
      }
      expect(running).toBe(await balanceFor({ organisation: organisation.id, payload }))
    })
  })

  describe('immutability @S-149', () => {
    let row: Doc

    beforeAll(async () => {
      const result = await adjustCredits({ delta: 3, note: 'Seed', organisation: orgs.brewA.id, payload })
      row = result.entry as Doc
    })

    it('refuses every update, even from system code', async () => {
      await expect(
        payload.update({ collection: CREDIT_LEDGER_SLUG, data: { delta: 300 }, id: row.id, ...system }),
      ).rejects.toSatisfy(failsWith(/can’t be changed/))
      await expect(
        payload.update({ collection: CREDIT_LEDGER_SLUG, data: { note: 'edited' }, id: row.id, overrideAccess: false, user: harness.superAdmin as never }),
      ).rejects.toThrow()
      const stored = (await payload.findByID({ collection: CREDIT_LEDGER_SLUG, depth: 0, id: row.id, ...system })) as Doc
      expect([stored.delta, stored.note]).toEqual([3, 'Seed'])
    })

    it('refuses every delete, even from system code', async () => {
      await expect(payload.delete({ collection: CREDIT_LEDGER_SLUG, id: row.id, ...system })).rejects.toSatisfy(failsWith(/kept for good/))
      await expect(
        payload.delete({ collection: CREDIT_LEDGER_SLUG, id: row.id, overrideAccess: false, user: harness.superAdmin as never }),
      ).rejects.toThrow()
      expect(await payload.findByID({ collection: CREDIT_LEDGER_SLUG, depth: 0, id: row.id, ...system })).toBeTruthy()
    })

    it('keeps the organisation, job and tenant a row points at', async () => {
      await expect(payload.delete({ collection: 'organisations', id: orgs.brewA.id, ...system })).rejects.toSatisfy(failsWith(/credit movement/))
      await expect(payload.delete({ collection: 'tenants', id: harness.tenantA.id, ...system })).rejects.toSatisfy(failsWith(/credit movement/))
    })

    it('lets a site manager record only adjustments, with a note, in their own tenant', async () => {
      const asAdmin = { overrideAccess: false, user: harness.tenantAdminA as never }
      const created = (await payload.create({
        collection: CREDIT_LEDGER_SLUG,
        data: { delta: 2, note: 'Goodwill', organisation: orgs.bankA.id, reason: 'adjustment', tenant: harness.tenantA.id },
        ...asAdmin,
      })) as Doc
      expect(created).toMatchObject({ actor: 'staff', delta: 2, reason: 'adjustment' })

      await expect(
        payload.create({
          collection: CREDIT_LEDGER_SLUG,
          data: { delta: 2, organisation: orgs.bankA.id, reason: 'adjustment', tenant: harness.tenantA.id },
          ...asAdmin,
        }),
      ).rejects.toSatisfy(failsWith(/Say why/))
      await expect(
        payload.create({
          collection: CREDIT_LEDGER_SLUG,
          data: { delta: 5, organisation: orgs.bankA.id, reason: 'opening', legacyRef: 'x', tenant: harness.tenantA.id },
          ...asAdmin,
        }),
      ).rejects.toSatisfy(failsWith(/adjustments only/))
      await expect(
        payload.create({
          collection: CREDIT_LEDGER_SLUG,
          data: { delta: 2, note: 'x', organisation: orgs.shopB.id, reason: 'adjustment', tenant: harness.tenantB.id },
          ...asAdmin,
        }),
      ).rejects.toThrow()
      await expect(
        payload.create({
          collection: CREDIT_LEDGER_SLUG,
          data: { delta: 2, note: 'x', organisation: orgs.bankA.id, reason: 'adjustment', tenant: harness.tenantA.id },
          overrideAccess: false,
          user: users.memberBank as never,
        }),
      ).rejects.toThrow()
    })
  })

  describe('tenant and organisation isolation @S-149', () => {
    beforeAll(async () => {
      await adjustCredits({ delta: 1, note: 'Bank seed', organisation: orgs.bankA.id, payload })
      await adjustCredits({ delta: 1, note: 'Shop seed', organisation: orgs.shopB.id, payload })
    })

    const visibleOrgs = async (user: unknown): Promise<number[]> => {
      const { docs } = await payload
        .find({ collection: CREDIT_LEDGER_SLUG, depth: 0, overrideAccess: false, pagination: false, user: user as never })
        .catch((error: Error) => {
          if (error.name === 'Forbidden') return { docs: [] }
          throw error
        })
      // oxlint-disable-next-line unicorn/no-array-sort
      return [...new Set(docs.map((doc) => Number((doc as Doc).organisation)))].sort((a, b) => a - b)
    }

    it('shows members their own organisation’s rows and site managers their tenant’s only', async () => {
      expect(await visibleOrgs(users.memberBrew)).toEqual([orgs.brewA.id])
      expect(await visibleOrgs(users.memberBank)).toEqual([orgs.bankA.id])
      const tenantA = await visibleOrgs(harness.tenantAdminA)
      expect(tenantA).toContain(orgs.brewA.id)
      expect(tenantA).not.toContain(orgs.shopB.id)
      expect(await visibleOrgs(harness.tenantAdminB)).toEqual([orgs.shopB.id])
      expect(await visibleOrgs(users.editorA)).toEqual([])
      expect(await visibleOrgs(undefined)).toEqual([])
    })

    it('hides the idempotency key and legacy reference from members', async () => {
      const { docs } = await payload.find({ collection: CREDIT_LEDGER_SLUG, depth: 0, overrideAccess: false, user: users.memberBrew as never })
      expect(docs.length).toBeGreaterThan(0)
      for (const doc of docs) {
        expect(doc).not.toHaveProperty('idempotencyKey')
        expect(doc).not.toHaveProperty('legacyRef')
      }
    })

    it('keeps balances apart per organisation', async () => {
      expect(await balanceFor({ organisation: orgs.shopB.id, payload })).toBe(1)
      await expect(consumeCredit({ job: (await job(orgs.bankA)).id, payload })).resolves.toBeTruthy()
      expect(await balanceFor({ organisation: orgs.shopB.id, payload })).toBe(1)
    })

    it('refuses an order or job of another organisation or tenant', async () => {
      const shopOrder = await packOrder(orgs.shopB, 1)
      const shopJob = await job(orgs.shopB)
      const asSystem = async (data: Record<string, unknown>) =>
        payload.create({ collection: CREDIT_LEDGER_SLUG, data: data as never, ...system })

      await expect(
        asSystem({ delta: 5, order: shopOrder.id, organisation: orgs.brewA.id, reason: 'bought', tenant: harness.tenantA.id }),
      ).rejects.toSatisfy(failsWith(/order of this organisation/))
      await expect(
        asSystem({ delta: -1, job: shopJob.id, organisation: orgs.brewA.id, reason: 'used', tenant: harness.tenantA.id }),
      ).rejects.toSatisfy(failsWith(/job of this organisation/))
      await expect(
        asSystem({ delta: 1, note: 'x', organisation: orgs.shopB.id, reason: 'adjustment', tenant: harness.tenantA.id }),
      ).rejects.toSatisfy(failsWith(/organisation from this row’s tenant/))
    })
  })

  describe('history endpoint @S-149', () => {
    const call = async (organisation: number, user: unknown): Promise<Response> => {
      const req = await createPayloadRequest({ payload, user: (user ?? null) as never })
      req.routeParams = { id: String(organisation) }
      return historyEndpoint.handler(req) as Promise<Response>
    }

    it('returns orders, credits and job events with a running balance to members and site managers', async () => {
      const organisation = await org(harness.tenantA.id, 'History')
      const member = await makeUser('member-history', [{ role: 'employer', tenant: harness.tenantA.id }], { organisation: organisation.id })
      const order = await packOrder(organisation, 2)
      await grantCredits({ order: order.id, payload })
      const listing = await job(organisation)
      await consumeCredit({ job: listing.id, payload })
      await recordOpeningCredits({ credits: 1, legacyRef: 'wp-pack:history', organisation: organisation.id, payload })

      const response = await call(organisation.id, member)
      expect(response.status).toBe(200)
      const history = (await response.json()) as any
      const credits = history.entries.filter((entry: any) => entry.kind === 'credit')
      expect(credits.map((entry: any) => [entry.event, entry.delta, entry.balance])).toEqual([
        ['bought', 2, 2],
        ['used', -1, 1],
        ['opening', 1, 2],
      ])
      expect(history.entries.some((entry: any) => entry.kind === 'order' && entry.order.id === order.id)).toBe(true)
      expect(history.entries.some((entry: any) => entry.kind === 'job' && entry.event === 'posted' && entry.job.id === listing.id)).toBe(true)
      expect(history.totals.balance).toBe(await balanceFor({ organisation: organisation.id, payload }))
      expect(credits.at(-1).credit).not.toHaveProperty('legacyRef')

      const asStaff = (await (await call(organisation.id, harness.tenantAdminA)).json()) as any
      expect(asStaff.entries.find((entry: any) => entry.event === 'opening').credit.legacyRef).toBe('wp-pack:history')
    })

    it('answers 404 to other organisations, other tenants and editors, and 401 to anonymous callers', async () => {
      expect((await call(orgs.brewA.id, users.memberBank)).status).toBe(404)
      expect((await call(orgs.brewA.id, harness.tenantAdminB)).status).toBe(404)
      expect((await call(orgs.brewA.id, users.editorA)).status).toBe(404)
      expect((await call(999_999, harness.superAdmin)).status).toBe(404)
      expect((await call(orgs.brewA.id, null)).status).toBe(401)
    })
  })
})
