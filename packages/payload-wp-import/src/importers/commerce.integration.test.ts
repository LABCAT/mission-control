import {
  addOnCollection,
  balanceFor,
  couponCollection,
  creditLedgerCollection,
  jobsCollection,
  locationsCollection,
  orderCollection,
  organisationsCollection,
  planCollection,
  taxonomyCollections,
  withPlanRestrictionGuards,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { COMMERCE_NOW, commerceTables, commerceUsersPlan } from '../test/commerce-fixtures'
import { createFixtureConnection } from '../test/fixtures'
import { commerceImporters } from './commerce'

/** The commerce importers against a real Payload: the order, coupon and ledger rules all apply. */
describe('commerce import against Payload @S-202', () => {
  let harness: TestHarness
  const system = { overrideAccess: true } as const
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        creditLedgerCollection(),
        orderCollection({ couponsEnabled: false }),
        jobsCollection({ richTextDescription: false, withOrder: true }),
        organisationsCollection({ mediaSlug: null }),
        couponCollection(),
        planCollection(),
        addOnCollection(),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
      ],
      tenantData: () => ({ currency: 'VUV' }),
      tenantFields: [{ name: 'currency', type: 'text' }],
    })
    const { payload, tenantA } = harness

    // What the earlier imports leave behind: organisations 7, 8 (users) and 82 (a job's company).
    for (const legacyId of [7, 8, 82]) {
      ids[`org${legacyId}`] = (await payload.create({
        collection: 'organisations',
        data: { legacyId, name: `Org ${legacyId}`, slug: `org-${legacyId}`, tenant: tenantA.id } as never,
        ...system,
      })).id as number
    }
    for (const [legacyId, org] of [[1001, 'org7'], [1002, 'org82']] as const) {
      ids[`job${legacyId}`] = (await payload.create({
        collection: 'jobs',
        data: { legacyId, organisation: ids[org], tenant: tenantA.id, title: `Job ${legacyId}` } as never,
        ...system,
      })).id as number
    }
    // The seed (PJ-87).
    for (const [legacyId, key, price, jobCredits] of [[26, 'regular-listing', 3900, 1], [28, 'job-pack', 17500, 5], [36084, 'enhanced-listing', 5900, 1]] as const) {
      ids[`plan${legacyId}`] = (await payload.create({
        collection: 'plans',
        data: { durationDays: 30, jobCredits, key, legacyId, name: key, price, tenant: tenantA.id } as never,
        ...system,
      })).id as number
    }
  }, 120_000)

  afterAll(async () => {
    await harness?.destroy()
  })

  const doImport = (dryRun: boolean) => {
    const importers = commerceImporters({ now: () => COMMERCE_NOW, planProvider: async () => commerceUsersPlan })
    const reader = new MysqlReader({ connect: async () => createFixtureConnection(commerceTables as never), pageSize: 4 })
    return runImport({
      dryRun,
      importers: [importers.plans, importers.coupons, importers.orders, importers.credits].map((importer) => ({ ...importer, dependsOn: [] })),
      payload: harness.payload as never,
      reader,
      tenant: harness.tenantA.id,
    })
  }

  const find = async (collection: string) =>
    (await harness.payload.find({ collection: collection as never, depth: 0, limit: 100, pagination: false, where: { tenant: { equals: harness.tenantA.id } }, ...system })).docs as Record<string, any>[]

  it('writes valid coupons, orders and opening credits, and a second run changes nothing', async () => {
    const dry = await doImport(true)
    // Only the unreadable pack and the order that charged tax fail; nothing was written.
    expect(dry.errors.map((e) => e.importer).toSorted()).toEqual(['credits', 'orders'])
    expect(await find('orders')).toHaveLength(0)

    const first = await doImport(false)
    expect(first.importers.coupons).toMatchObject({ created: 2, failed: 0 })
    expect(first.importers.orders).toMatchObject({ created: 5, failed: 1 })
    expect(first.importers.credits).toMatchObject({ created: 2, failed: 1 })

    // The real collection kept the use count (its guard resets anything not written under the import's context).
    const coupons = await find('coupons')
    expect(coupons.find((c) => c.code === 'LINKPS')).toMatchObject({ amount: 1900, discountType: 'flat', useCount: 501 })

    const orders = await find('orders')
    const byLegacy = Object.fromEntries(orders.map((o) => [o.legacyId, o]))
    expect(byLegacy[5001]).toMatchObject({ currency: 'VUV', organisation: ids.org7, plan: ids.plan26, status: 'invoiced', total: 3900 })
    expect(byLegacy[5001].jobs).toEqual([ids.job1001])
    expect(byLegacy[5001].externalRefs).toEqual([expect.objectContaining({ externalId: 'inv-0001', provider: 'xero' })])
    expect(byLegacy[5001].log).toEqual([expect.objectContaining({ event: 'created', note: 'Imported from WordPress transaction 5001', to: 'invoiced' })])
    expect(byLegacy[5002]).toMatchObject({ organisation: ids.org82, paidAt: '2026-09-05T00:00:00.000Z', status: 'paid' })
    expect(byLegacy[5007]).toMatchObject({ paymentMethod: 'free', total: 0 })
    // The order's own date, not the day it was imported.
    expect(byLegacy[5001].createdAt).toBe('2026-10-14T22:00:00.000Z')

    // The balance is the sum of the opening rows, per organisation.
    expect(await balanceFor({ organisation: ids.org7, payload: harness.payload } as never)).toBe(3)
    expect(await balanceFor({ organisation: ids.org8, payload: harness.payload } as never)).toBe(6)
    const ledger = await find('credit-ledger')
    expect(ledger).toHaveLength(2)
    expect(ledger.every((row) => row.reason === 'opening' && row.actor === 'system' && String(row.idempotencyKey).startsWith('opening:'))).toBe(true)

    const second = await doImport(false)
    expect(second.importers.coupons).toMatchObject({ created: 0, failed: 0, updated: 2 })
    expect(second.importers.orders).toMatchObject({ created: 0, updated: 5 })
    expect(second.importers.credits).toMatchObject({ created: 0 })
    expect(await find('orders')).toHaveLength(5)
    expect(await find('credit-ledger')).toHaveLength(2)
    expect(await find('coupons')).toHaveLength(2)
    // The re-run did not move anything on the orders or log a change.
    const again = Object.fromEntries((await find('orders')).map((o) => [o.legacyId, o]))
    expect(again[5001].log).toHaveLength(1)
    expect(again[5002].log).toHaveLength(1)
    expect(again[5002].paidAt).toBe('2026-09-05T00:00:00.000Z')
  }, 120_000)

  it('keeps the live use count of a coupon across a re-run', async () => {
    const [linkps] = (await find('coupons')).filter((c) => c.code === 'LINKPS')
    await harness.payload.update({ collection: 'coupons', context: { couponUseCount: true }, data: { useCount: 530 }, id: linkps!.id, ...system })
    await doImport(false)
    expect((await find('coupons')).find((c) => c.code === 'LINKPS')!.useCount).toBe(530)
  }, 120_000)
})
