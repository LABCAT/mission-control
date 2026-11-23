import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { COMMERCE_NOW, commerceTables as tables, commerceUsersPlan as usersPlan } from '../test/commerce-fixtures'
import { createFixtureConnection } from '../test/fixtures'
import type { ImportPayload } from '../types'
import {
  commerceImporters,
  couponExpired,
  orderCutoff,
  parseCouponDate,
  remainingPackCredits,
  toMinorUnits,
} from './commerce'

const NOW = COMMERCE_NOW
const TENANT = 1

const seedStore = () => ({
  jobs: [
    { id: 301, legacyId: 1001, organisation: 71, tenant: TENANT },
    { id: 302, legacyId: 1002, organisation: 82, tenant: TENANT },
  ],
  organisations: [
    { id: 71, legacyId: 7, tenant: TENANT },
    { id: 81, legacyId: 8, tenant: TENANT },
    { id: 82, legacyId: 82, tenant: TENANT },
  ],
  plans: [
    { id: 11, durationDays: 30, jobCredits: 1, key: 'regular-listing', legacyId: 26, price: 3900, tenant: TENANT },
    { id: 12, durationDays: 30, jobCredits: 5, key: 'job-pack', legacyId: 28, price: 17500, tenant: TENANT },
    { id: 13, durationDays: 30, jobCredits: 1, key: 'enhanced-listing', legacyId: 36084, price: 5900, tenant: TENANT },
  ],
  tenants: [{ currency: 'VUV', id: TENANT }],
})

const setup = (store = seedStore()) => {
  const fake = createFakePayload(store as never)
  const contexts: { collection: string; context: unknown }[] = []
  const create = fake.payload.create
  const payload: ImportPayload = {
    ...fake.payload,
    create: (args) => {
      contexts.push({ collection: args.collection, context: args.context })
      return create(args)
    },
  }
  const reader = new MysqlReader({ connect: async () => createFixtureConnection(tables as never), pageSize: 3 })
  const importers = commerceImporters({ now: () => NOW, planProvider: async () => usersPlan })
  const run = (names: ('coupons' | 'credits' | 'orders' | 'plans')[], dryRun = false) =>
    runImport({
      dryRun,
      importers: names.map((name) => ({ ...importers[name], dependsOn: [] })),
      payload,
      reader,
      tenant: TENANT,
    })
  return { contexts, fake, run, store: fake.store }
}

describe('legacy money and dates', () => {
  it('reads amounts as whole minor units of the currency, never rounding', () => {
    expect(toMinorUnits('3900', 'VUV')).toBe(3900)
    expect(toMinorUnits('1,900', 'VUV')).toBe(1900)
    expect(toMinorUnits('39.00', 'VUV')).toBe(39)
    expect(toMinorUnits('39.5', 'VUV')).toBeNull()
    expect(toMinorUnits('39.5', 'NZD')).toBe(3950)
    expect(toMinorUnits('-5', 'VUV')).toBeNull()
    expect(toMinorUnits('', 'VUV')).toBeNull()
    expect(toMinorUnits('free', 'VUV')).toBeNull()
  })

  it('treats a coupon as valid through the whole of its last day', () => {
    expect(parseCouponDate('02/30/2026')).toBeNull()
    expect(couponExpired('', NOW)).toBe(false)
    expect(couponExpired('11/20/2026', NOW)).toBe(false)
    expect(couponExpired('11/19/2026', NOW)).toBe(true)
    expect(couponExpired('garbage', NOW)).toBe(false)
  })

  it('opens the order window 24 months back', () => {
    expect(orderCutoff(NOW, 24).toISOString()).toBe('2024-11-20T00:00:00.000Z')
  })

  it('reads a pack balance as a number or as limit minus used, and refuses anything else', () => {
    expect(remainingPackCredits('3')).toBe(3)
    expect(remainingPackCredits('a:2:{s:10:"jobs_limit";i:10;s:10:"jobs_count";i:4;}')).toBe(6)
    expect(remainingPackCredits('a:2:{s:10:"jobs_limit";i:5;s:10:"jobs_count";i:9;}')).toBe(0)
    expect(remainingPackCredits('a:1:{s:3:"foo";i:1;}')).toBeNull()
    expect(remainingPackCredits('')).toBeNull()
  })
})

describe('plans: the seed is checked against the live plans @S-200', () => {
  it('passes when the seeded prices, durations and pack sizes match, and skips the pending plan', async () => {
    const { run, store } = setup()
    const summary = await run(['plans'])
    expect(summary.errors).toEqual([])
    expect(summary.importers.plans).toMatchObject({
      created: 0,
      skipReasons: { 'matches-seed': 3, 'not-published-pending': 1 },
      updated: 0,
    })
    expect(store.plans).toHaveLength(3)
  })

  it('fails a plan that drifted, naming what differs, and never writes', async () => {
    const drifted = seedStore()
    drifted.plans[0]!.price = 3500
    drifted.plans[1]!.jobCredits = 10
    const { run, fake } = setup(drifted)
    const summary = await run(['plans'])
    expect(summary.importers.plans!.failed).toBe(2)
    expect(summary.errors.map((e) => e.message).join('\n')).toMatch(/regular-listing.*price 3500 is 3900/)
    expect(summary.errors.map((e) => e.message).join('\n')).toMatch(/job-pack.*job credits 10 is 5/)
    expect(fake.writes).toEqual([])
  })

  it('fails a live plan that is missing from the tenant', async () => {
    const missing = seedStore()
    missing.plans.pop()
    const summary = await setup(missing).run(['plans'])
    expect(summary.errors[0]!.message).toMatch(/36084.*run the plan seed/)
  })
})

describe('coupons @S-201', () => {
  it('keeps LINKPS and a live coupon, drops the expired one, and keeps the use counts', async () => {
    const { contexts, run, store } = setup()
    const summary = await run(['coupons'])
    expect(summary.errors).toEqual([])
    expect(summary.importers.coupons).toMatchObject({ created: 2, skipReasons: { expired: 1 } })

    const byCode = Object.fromEntries((store.coupons ?? []).map((c) => [c.code, c]))
    expect(Object.keys(byCode).toSorted()).toEqual(['LINKPS', 'SPRING25'])
    expect(byCode.LINKPS).toMatchObject({ active: true, amount: 1900, discountType: 'flat', legacyId: 38641, maxUses: null, tenant: TENANT, useCount: 501 })
    expect(byCode.SPRING25).toMatchObject({ amount: 25, discountType: 'percent', maxUses: 10, useCount: 3 })
    // The collection resets a use count that is not written under this context.
    expect(contexts.every((c) => (c.context as { couponUseCount?: boolean }).couponUseCount === true)).toBe(true)
  })

  it('imports expired coupons only when the setting is on', async () => {
    const fake = createFakePayload(seedStore() as never)
    const importers = commerceImporters({ importExpiredCoupons: true, now: () => NOW, planProvider: async () => usersPlan })
    const reader = new MysqlReader({ connect: async () => createFixtureConnection(tables as never) })
    const summary = await runImport({ importers: [importers.coupons], payload: fake.payload, reader, tenant: TENANT })
    expect(summary.importers.coupons!.created).toBe(3)
  })

  it('does not reset a use count the live site has moved on, and does not duplicate', async () => {
    const { run, store } = setup()
    await run(['coupons'])
    store.coupons!.find((c) => c.code === 'LINKPS')!.useCount = 530
    const second = await run(['coupons'])
    expect(second.importers.coupons).toMatchObject({ created: 0, updated: 2 })
    expect(store.coupons).toHaveLength(2)
    expect(store.coupons!.find((c) => c.code === 'LINKPS')!.useCount).toBe(530)
  })

  it('reports the coupons and how often each was used @S-204', async () => {
    const summary = await setup().run(['coupons'], true)
    expect(summary.importers.coupons!.report).toMatchObject({
      'coupon LINKPS use count': 501,
      'coupons expired, not imported': 1,
      'coupons imported': 2,
    })
  })
})

describe('orders @S-202', () => {
  const orders = (store: ReturnType<typeof setup>['store']) => Object.fromEntries((store.orders ?? []).map((o) => [o.legacyId, o]))

  it('maps the status, organisation, plan, jobs and Xero invoice, and keeps the money in minor units', async () => {
    const { run, store } = setup()
    const summary = await run(['orders'])
    const byId = orders(store)

    // A pending bank transfer is invoiced (paid through Xero), the organisation is the job's.
    expect(byId[5001]).toMatchObject({
      currency: 'VUV',
      discount: 0,
      externalRefs: [{ externalId: 'inv-0001', provider: 'xero' }],
      jobs: [301],
      organisation: 71,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      plan: 11,
      status: 'invoiced',
      subtotal: 3900,
      tax: 0,
      tenant: TENANT,
      total: 3900,
    })
    expect(byId[5001]!.paidAt).toBeUndefined()
    expect(byId[5001]!.createdAt).toBe('2026-10-14T22:00:00.000Z')

    // A paid order carries its paid date, and a Xero invoice of its own.
    expect(byId[5002]).toMatchObject({ organisation: 82, paidAt: '2026-09-05T00:00:00.000Z', plan: 13, status: 'paid', total: 5900 })

    expect(byId[5003]).toMatchObject({ status: 'failed' })
    // No money, no payment provider: a free order totals 0.
    expect(byId[5007]).toMatchObject({ paymentMethod: 'free', status: 'paid', total: 0 })
    expect(byId[5007]!.paymentProvider).toBeUndefined()
    // A pack purchase has no job: it belongs to the buyer's organisation and names the pack plan.
    expect(byId[5008]).toMatchObject({ jobs: [], organisation: 71, plan: 12, status: 'invoiced', total: 17500 })

    expect(summary.importers.orders).toMatchObject({ created: 5 })
  })

  it('skips what it cannot trust, and reports why', async () => {
    const { run } = setup()
    const summary = await run(['orders'])
    expect(summary.importers.orders!.skipReasons).toEqual({
      'no-organisation': 1,
      'no-total': 1,
      'status-tr_refunded': 1,
    })
    expect(summary.importers.orders!.report).toMatchObject({ 'orders older than the window, not imported': 1 })
  })

  it('refuses an order that charged tax rather than dropping the tax', async () => {
    const summary = await setup().run(['orders'])
    expect(summary.importers.orders!.failed).toBe(1)
    expect(summary.errors).toEqual([expect.objectContaining({ importer: 'orders', message: expect.stringMatching(/Order 5009 charged tax/) })])
  })

  it('reports orders by month, by status and the total @S-204', async () => {
    const summary = await setup().run(['orders'], true)
    expect(summary.importers.orders!.report).toMatchObject({
      'orders 2026-08': 1,
      'orders 2026-09': 1,
      'orders 2026-10': 3,
      'orders status failed': 1,
      'orders status invoiced': 2,
      'orders status paid': 2,
      'orders total minor units': 3900 + 5900 + 3900 + 0 + 17500,
      'orders with a Xero invoice': 2,
    })
  })

  it('writes nothing on a dry run, and the counts match the real run', async () => {
    const dry = setup()
    const dryRun = await dry.run(['orders'], true)
    expect(dry.fake.writes).toEqual([])
    const real = await setup().run(['orders'])
    expect(dryRun.importers.orders).toMatchObject({ created: real.importers.orders!.created, failed: real.importers.orders!.failed })
  })

  it('is idempotent: a second run creates nothing, and never rewrites what the order was sold for', async () => {
    const { run, store } = setup()
    await run(['orders'])
    const money = structuredClone((store.orders ?? []).map(({ currency, discount, subtotal, tax, total, plan, paymentMethod }) => ({ currency, discount, subtotal, tax, total, plan, paymentMethod })))
    const second = await run(['orders'])
    expect(second.importers.orders).toMatchObject({ created: 0, updated: 5 })
    expect(store.orders).toHaveLength(5)
    expect((store.orders ?? []).map(({ currency, discount, subtotal, tax, total, plan, paymentMethod }) => ({ currency, discount, subtotal, tax, total, plan, paymentMethod }))).toEqual(money)
  })

  it('only ever writes into the tenant it was given', async () => {
    const { run, store } = setup()
    await run(['orders'])
    expect((store.orders ?? []).every((order) => order.tenant === TENANT)).toBe(true)
  })

  it('takes the organisation only from the tenant’s own jobs', async () => {
    const other = seedStore()
    other.jobs[0]!.tenant = 2 // a job from another tenant that shares a legacy id
    const { run, store } = setup(other)
    await run(['orders'])
    // 5001 has no job in this tenant here, so it falls back to the buyer's organisation (71 either way)
    expect(orders(store)[5001]).toMatchObject({ jobs: [], organisation: 71 })
  })
})

describe('credits: opening balances @S-203', () => {
  const ledger = (store: ReturnType<typeof setup>['store']) => store['credit-ledger'] ?? []

  it('writes one opening row per pack with its legacy reference, attached to the organisation', async () => {
    const { run, store } = setup()
    const summary = await run(['credits'])
    expect(ledger(store)).toEqual([
      expect.objectContaining({ delta: 3, legacyRef: 'wp-user-pack:7:_jr_user_pack-28-5008', organisation: 71, reason: 'opening', tenant: TENANT }),
      expect.objectContaining({ delta: 6, legacyRef: 'wp-user-pack:8:_jr_user_pack-36082-4000', organisation: 81, reason: 'opening', tenant: TENANT }),
    ])
    expect(ledger(store).every((row) => row.legacyId === undefined)).toBe(true)
    expect(summary.importers.credits).toMatchObject({ created: 2 })
  })

  it('has ledger sums that equal the legacy balances, per organisation and in total @S-204', async () => {
    const { run, store } = setup()
    const summary = await run(['credits'])
    const sum = (organisation: number) => ledger(store).filter((row) => row.organisation === organisation).reduce((n, row) => n + row.delta, 0)
    expect(sum(71)).toBe(3) // user 7: a pack with 3 left
    expect(sum(81)).toBe(6) // user 8: 10 bought, 4 used
    expect(summary.importers.credits!.report).toMatchObject({
      'opening credits (sum)': 9,
      'opening credits of legacy organisation 7': 3,
      'opening credits of legacy organisation 8': 6,
      'opening rows': 2,
    })
    expect(ledger(store).reduce((n, row) => n + row.delta, 0)).toBe(summary.importers.credits!.report!['opening credits (sum)'])
  })

  it('skips a used-up pack and a user that was not imported, and fails a balance it cannot read', async () => {
    const summary = await setup().run(['credits'])
    expect(summary.importers.credits!.skipReasons).toEqual({ 'empty-pack': 1, 'user-not-imported': 1 })
    expect(summary.importers.credits!.report).toMatchObject({ 'credits of users not imported (sum)': 2 })
    expect(summary.errors).toEqual([expect.objectContaining({ importer: 'credits', message: expect.stringMatching(/cannot read the remaining credits/) })])
  })

  it('is idempotent: a second run adds no row and updates none', async () => {
    const { run, store, fake } = setup()
    await run(['credits'])
    const writes = fake.writes.length
    const second = await run(['credits'])
    expect(second.importers.credits).toMatchObject({ created: 0, updated: 0, skipReasons: expect.objectContaining({ 'already-imported': 2 }) })
    expect(ledger(store)).toHaveLength(2)
    expect(fake.writes).toHaveLength(writes)
  })

  it('does not bring the "active packs" list over as credits', async () => {
    const { run, store } = setup()
    await run(['credits'])
    expect(ledger(store).some((row) => String(row.legacyRef).includes('packs_active'))).toBe(false)
  })
})
