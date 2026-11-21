import type { CollectionConfig, Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from '../add-ons'
import { planCollection, withPlanRestrictionGuards } from '../plans'
import { taxonomyCollections } from '../taxonomies'
import { bootTestPayload, type TestHarness } from '../test'
import { orderCollection, ORDERS_SLUG } from '../orders'
import {
  activeTenantID,
  currencyMinorUnits,
  formatMinorUnits,
  jobBoardSlugs,
  loadSiteManagerDashboard,
} from './dashboard'
import { JOBS_SLUG, jobsCollection } from '../collections/jobs'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, resolvePayloadJobsSlugs } from '../slugs'
import { locationsCollection } from '../collections/locations'
import { organisationsCollection } from '../collections/organisations'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'currencyMinorUnits', type: 'number' },
  { name: 'defaultLocale', type: 'text' },
]

/** Main's real orders collection (PJ-23), under the slugs a test names. */
const realOrders = (slugs = DEFAULT_PAYLOAD_JOBS_SLUGS): CollectionConfig =>
  orderCollection({ couponsEnabled: false, slugs })

const Orders = realOrders()

describe('site manager dashboard @S-117', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}

  const create = async (collection: string, data: Record<string, unknown>) =>
    ((await harness.payload.create({ collection, data, overrideAccess: true })) as { id: number }).id

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        Orders,
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ tenantScoped: true }),
      ],
      tenantData: (which) => ({
        currency: which === 'A' ? 'VUV' : 'NZD',
        currencyMinorUnits: which === 'A' ? 0 : 2,
        defaultLocale: 'en',
      }),
      tenantFields,
    })
    const { tenantA, tenantB } = harness

    ids.orgA = await create('organisations', { name: 'Org A', slug: 'org-a', tenant: tenantA.id })
    ids.orgB = await create('organisations', { name: 'Org B', slug: 'org-b', tenant: tenantB.id })

    for (const [title, status, tenant, organisation] of [
      ['Pending A', 'pending', tenantA.id, ids.orgA],
      ['Second pending A', 'pending', tenantA.id, ids.orgA],
      ['Live A', 'published', tenantA.id, ids.orgA],
      ['Ended A', 'published', tenantA.id, ids.orgA],
      ['Pending B', 'pending', tenantB.id, ids.orgB],
    ] as const) {
      ids[title] = await create(JOBS_SLUG, {
        organisation,
        status,
        tenant,
        title,
      })
    }
    await harness.payload.update({
      collection: JOBS_SLUG,
      data: { status: 'expired' },
      id: ids['Ended A'],
      overrideAccess: true,
    })

    ids.orderA = await create(ORDERS_SLUG, {
      currency: 'VUV',
      organisation: ids.orgA,
      status: 'paid',
      tenant: tenantA.id,
      subtotal: 150000,
      tax: 0,
      discount: 0,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      total: 150000,
    })
    ids.orderB = await create(ORDERS_SLUG, {
      currency: 'NZD',
      organisation: ids.orgB,
      status: 'paid',
      tenant: tenantB.id,
      subtotal: 2500,
      tax: 0,
      discount: 0,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      total: 2500,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('counts and lists only the active tenant’s jobs and orders @S-148', async () => {
    const dashboard = await loadSiteManagerDashboard({
      payload: harness.payload,
      tenantID: harness.tenantA.id,
      user: harness.tenantAdminA as never,
    })

    expect(dashboard.tenant).toMatchObject({
      currency: 'VUV',
      currencyMinorUnits: 0,
      id: harness.tenantA.id,
      locale: 'en',
    })
    expect(dashboard.jobCounts).toEqual({ ended: 1, live: 1, pending: 2 })
    expect(dashboard.pendingJobs.map((job) => job.title)).toEqual([
      'Pending A',
      'Second pending A',
    ])
    expect(dashboard.pendingJobs.every((job) => job.organisation === 'Org A')).toBe(true)
    expect(dashboard.orders?.count).toBe(1)
    expect(dashboard.orders?.recent.map((order) => order.id)).toEqual([ids.orderA])
  })

  it('gives other tenants’ numbers nothing when asked for them', async () => {
    const dashboard = await loadSiteManagerDashboard({
      payload: harness.payload,
      tenantID: harness.tenantB.id,
      user: harness.tenantAdminA as never,
    })

    expect(dashboard.jobCounts).toEqual({ ended: 0, live: 0, pending: 0 })
    expect(dashboard.pendingJobs).toEqual([])
    expect(dashboard.orders).toMatchObject({ count: 0, recent: [] })
  })

  it('reports the tenant’s own orders as null when the host has no orders collection yet @S-148', async () => {
    const dashboard = await loadSiteManagerDashboard({
      payload: harness.payload,
      slugs: { orders: 'not-installed-yet' },
      tenantID: harness.tenantA.id,
      user: harness.tenantAdminA as never,
    })

    expect(dashboard.orders).toBeNull()
  })

  it('reads the resolved slugs the plugin recorded, not a hard-coded one', () => {
    const config = {
      custom: { payloadJobs: { slugs: { jobs: 'listings', tenants: 'sites' } } },
    } as never

    expect(jobBoardSlugs(config)).toEqual({ jobs: 'listings', tenants: 'sites' })
    expect(jobBoardSlugs({ custom: {} } as never)).toEqual({})
  })

  it('resolves the active tenant from the selector cookie, falling back to the first', () => {
    const user = harness.tenantAdminA as never

    expect(activeTenantID(user, null)).toBe(harness.tenantA.id)
    expect(activeTenantID(user, String(harness.tenantA.id))).toBe(harness.tenantA.id)
    // A cookie naming somebody else's tenant is ignored, not trusted.
    expect(activeTenantID(user, String(harness.tenantB.id))).toBe(harness.tenantA.id)
    expect(activeTenantID(harness.superAdmin as never, null)).toBeNull()
    expect(activeTenantID(null, null)).toBeNull()
  })
})

describe('dashboard money', () => {
  it('uses ICU’s exponent per currency, with the tenant’s override winning', () => {
    expect(currencyMinorUnits('VUV')).toBe(0)
    expect(currencyMinorUnits('NZD')).toBe(2)

    expect(formatMinorUnits(150000, { currency: 'VUV' })).toContain('150,000')
    expect(formatMinorUnits(150000, { currency: 'VUV' })).not.toContain('.')
    expect(formatMinorUnits(2500, { currency: 'NZD' })).toContain('25.00')
    expect(formatMinorUnits(2500, { currency: 'NZD', minorUnits: 0 })).toContain('2,500')
  })

  it('never divides into a float', () => {
    expect(formatMinorUnits(123456789, { currency: 'VUV', minorUnits: 2 })).toContain('1,234,567.89')
  })

  it('refuses an amount without an ISO currency code', () => {
    expect(() => formatMinorUnits(100, { currency: 'dollars' })).toThrow(TypeError)
  })
})

describe('site manager dashboard with renamed collections @S-117', () => {
  let harness: TestHarness
  let pendingJobID: number

  const slugs = { ...resolvePayloadJobsSlugs(), jobs: 'vacancies', organisations: 'employers' }

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        realOrders({ ...slugs, orders: 'purchases' }),
        organisationsCollection({ mediaSlug: null, slug: 'employers', tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ slugs, tenantScoped: true }),
      ],
      tenantData: () => ({ currency: 'VUV', currencyMinorUnits: 0, defaultLocale: 'en' }),
      tenantFields,
    })

    const org = (await harness.payload.create({
      collection: 'employers',
      data: { name: 'Renamed Org', slug: 'renamed-org', tenant: harness.tenantA.id },
      overrideAccess: true,
    })) as { id: number }

    pendingJobID = (
      (await harness.payload.create({
        collection: 'vacancies',
        data: {
          organisation: org.id,
          status: 'pending',
          tenant: harness.tenantA.id,
          title: 'Renamed pending',
        },
        overrideAccess: true,
      })) as { id: number }
    ).id

    await harness.payload.create({
      collection: 'purchases',
      data: {
        currency: 'VUV',
        organisation: org.id,
        status: 'pending',
        tenant: harness.tenantA.id,
        subtotal: 1500,
      tax: 0,
      discount: 0,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      total: 1500,
      },
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('counts the host’s renamed jobs and orders @S-148', async () => {
    const dashboard = await loadSiteManagerDashboard({
      payload: harness.payload,
      slugs: { jobs: 'vacancies', orders: 'purchases' },
      tenantID: harness.tenantA.id,
      user: harness.tenantAdminA as never,
    })

    expect(dashboard.jobCounts.pending).toBe(1)
    expect(dashboard.pendingJobs).toEqual([
      { id: pendingJobID, organisation: 'Renamed Org', title: 'Renamed pending' },
    ])
    expect(dashboard.orders?.slug).toBe('purchases')
    expect(dashboard.orders?.count).toBe(1)
    expect(dashboard.orders?.recent[0]?.totalMinor).toBe(1500)
  })
})
