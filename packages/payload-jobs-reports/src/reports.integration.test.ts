import type { CollectionConfig, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createPayloadJobsRegistry,
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  type PayloadJobsRegistry,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'

import { reportEndpoints } from './endpoint'
import { JOB_VIEWS_REPORT_KEY, JOBS_ORDERS_REPORT_KEY, reportDefinitions, REPORTS_ADD_ON_KEY } from './reports'
import { runReportCSV } from './service'

/** Just the fields the reports read; the real collections live in payload-jobs. */
const Organisations: CollectionConfig = {
  slug: 'organisations',
  fields: [{ name: 'name', type: 'text' }],
  versions: false,
}
const Jobs: CollectionConfig = {
  slug: 'jobs',
  fields: [
    { name: 'title', type: 'text' },
    { name: 'status', type: 'text' },
    { name: 'organisation', type: 'relationship', relationTo: 'organisations' },
    { name: 'publishedAt', type: 'date' },
    { name: 'expiresAt', type: 'date' },
    { name: 'views', type: 'number', defaultValue: 0 },
  ],
  versions: false,
}
const Orders: CollectionConfig = {
  slug: 'orders',
  fields: [
    { name: 'status', type: 'text' },
    { name: 'currency', type: 'text' },
    { name: 'total', type: 'number' },
    { name: 'tax', type: 'number' },
    { name: 'paidAt', type: 'date' },
    { name: 'jobs', type: 'relationship', hasMany: true, relationTo: 'jobs' },
  ],
  versions: false,
}

let harness: TestHarness
let registry: PayloadJobsRegistry
const created: Record<string, number> = {}

const run = (tenant: number, key: string, extra: Record<string, unknown> = {}) =>
  runReportCSV(registry, { key, payload: harness.payload, tenantID: tenant, ...extra })

const setAddOns = (tenant: number, addOns: string[] | null) =>
  harness.payload.update({ collection: 'tenants', data: { addOns } as never, id: tenant, overrideAccess: true })

const lines = (csv: string) => csv.trimEnd().split('\r\n')

const call = (user: unknown, path: string, query = '', key?: string) => {
  const endpoint = reportEndpoints(registry).find((entry) => entry.path === path)!

  return endpoint.handler({
    payload: harness.payload,
    routeParams: key ? { key } : {},
    searchParams: new URLSearchParams(query),
    user,
  } as unknown as PayloadRequest)
}

beforeAll(async () => {
  harness = await bootTestPayload({
    collections: [Organisations, Jobs, Orders],
    tenantData: (which) => ({ timezone: which === 'A' ? 'Pacific/Efate' : 'UTC' }),
    tenantFields: [
      { name: 'timezone', type: 'text' },
      { name: 'addOns', type: 'json' },
    ],
  })
  registry = createPayloadJobsRegistry({
    settingsSlug: 'job-board-settings',
    slugs: DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenancy: 'multi',
    tenantsSlug: 'tenants',
  })
  registry.addOns.register({ key: REPORTS_ADD_ON_KEY, label: 'Reports' })
  for (const report of reportDefinitions(registry)) registry.reports.register(report)

  const { payload, tenantA, tenantB } = harness
  const org = await payload.create({
    collection: 'organisations' as never,
    data: { name: '=cmd|"/c calc"!A1', tenant: tenantA.id } as never,
    overrideAccess: true,
  })
  const orgB = await payload.create({
    collection: 'organisations' as never,
    data: { name: 'Other org', tenant: tenantB.id } as never,
    overrideAccess: true,
  })
  const job = (title: string, tenant: number, createdAt: string, views = 0) =>
    payload.create({
      collection: 'jobs' as never,
      data: { createdAt, organisation: tenant === tenantA.id ? org.id : orgB.id, status: 'published', tenant, title, views } as never,
      overrideAccess: true,
    })

  // Pacific/Efate is UTC+11: 13:30Z on 31 March is 00:30 on 1 April there.
  const before = await job('Last of March, Efate', tenantA.id, '2026-03-31T12:59:59.000Z', 5)
  const first = await job('First of April, Efate', tenantA.id, '2026-03-31T13:00:00.000Z', 9_000_000)
  const last = await job('Last of April, Efate', tenantA.id, '2026-04-30T12:59:59.000Z', 7)
  const after = await job('First of May, Efate', tenantA.id, '2026-04-30T13:00:00.000Z', 1)
  const other = await job('Tenant B job', tenantB.id, '2026-04-15T00:00:00.000Z', 99)
  Object.assign(created, { after: after.id, before: before.id, first: first.id, last: last.id, other: other.id })

  await payload.create({
    collection: 'orders' as never,
    data: { currency: 'VUV', jobs: [first.id], status: 'paid', tax: 5, tenant: tenantA.id, total: 5000 } as never,
    overrideAccess: true,
  })
  await payload.create({
    collection: 'orders' as never,
    data: { currency: 'NZD', jobs: [other.id], status: 'paid', tenant: tenantB.id, total: 777 } as never,
    overrideAccess: true,
  })
}, 120_000)

afterAll(async () => {
  await harness?.destroy()
})

describe('jobs and orders by month @S-104', () => {
  it('includes both range ends in the tenant timezone, and nothing outside', async () => {
    const { csv } = await run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, {
      fields: ['month', 'jobTitle'],
      from: '2026-04-01',
      to: '2026-04-30',
    })

    expect(lines(csv)).toEqual(['month,jobTitle', '2026-04,"First of April, Efate"', '2026-04,"Last of April, Efate"'])
  })

  it('never returns another tenant, even for an unbounded range', async () => {
    const { csv } = await run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, { fields: ['jobTitle', 'orderTotal'] })

    expect(csv).not.toContain('Tenant B')
    expect(csv).not.toContain('777')
    expect(lines(csv)).toHaveLength(5)

    const b = await run(harness.tenantB.id, JOBS_ORDERS_REPORT_KEY, { fields: ['jobTitle', 'currency', 'orderTotal'] })
    expect(lines(b.csv)).toEqual(['jobTitle,currency,orderTotal', 'Tenant B job,NZD,777'])
  })

  it('joins the order as minor units plus currency, and defuses formulas in text', async () => {
    const { csv } = await run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, {
      fields: ['organisation', 'currency', 'orderTotal', 'orderStatus'],
      from: '2026-04-01',
      to: '2026-04-01',
    })

    expect(lines(csv)[1]).toBe(`"'=cmd|""/c calc""!A1",paid,VUV,5000`)
  })

  it('uses the default fields when none are chosen, and refuses unknown ones', async () => {
    const { csv, filename } = await run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, { from: '2026-04-01', to: '2026-04-01' })

    expect(lines(csv)[0]).toBe('month,jobId,jobTitle,jobStatus,organisation,orderId,orderStatus,currency,orderTotal')
    expect(filename).toBe('jobs-orders-by-month-2026-04-01_to_2026-04-01.csv')
    await expect(run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, { fields: ['password'] })).rejects.toMatchObject({
      status: 400,
    })
    await expect(run(harness.tenantA.id, JOBS_ORDERS_REPORT_KEY, { from: 'nope' })).rejects.toMatchObject({ status: 400 })
  })
})

describe('job views @S-105', () => {
  it('lists views per job including the imported legacy totals', async () => {
    const { csv } = await run(harness.tenantA.id, JOB_VIEWS_REPORT_KEY, {
      fields: ['jobTitle', 'views'],
      from: '2026-04-01',
      to: '2026-04-30',
    })

    expect(lines(csv)).toEqual(['jobTitle,views', '"First of April, Efate",9000000', '"Last of April, Efate",7'])
  })

  it('is scoped to the tenant', async () => {
    const { csv } = await run(harness.tenantB.id, JOB_VIEWS_REPORT_KEY, { fields: ['jobTitle', 'views'] })

    expect(lines(csv)).toEqual(['jobTitle,views', 'Tenant B job,99'])
  })
})

describe('endpoints and the add-on switch @S-104 @S-147', () => {

  it('needs a signed-in site manager of that tenant', async () => {
    expect((await call(null, '/reports')).status).toBe(401)
    expect((await call({ id: 1, role: 'user', tenants: [] }, '/reports')).status).toBe(403)
    expect(
      (await call({ id: 1, role: 'user', tenants: [{ role: 'editor', tenant: harness.tenantA.id }] }, '/reports')).status,
    ).toBe(403)
    // Site manager of A asking for B.
    expect((await call(harness.tenantAdminA, '/reports', `tenant=${harness.tenantB.id}`)).status).toBe(403)
    expect(
      (await call(harness.tenantAdminA, '/reports/:key/csv', `tenant=${harness.tenantB.id}`, JOB_VIEWS_REPORT_KEY)).status,
    ).toBe(403)
  })

  it('lists the reports and downloads a CSV for a site manager', async () => {
    const list = await call(harness.tenantAdminA, '/reports')
    expect(((await list.json()) as { reports: { key: string }[] }).reports.map((r) => r.key)).toEqual([
      JOBS_ORDERS_REPORT_KEY,
      JOB_VIEWS_REPORT_KEY,
    ])

    const download = await call(
      harness.tenantAdminA,
      '/reports/:key/csv',
      'fields=jobTitle,views&from=2026-04-01&to=2026-04-01',
      JOB_VIEWS_REPORT_KEY,
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('text/csv')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(await download.text()).toBe('jobTitle,views\r\n"First of April, Efate",9000000\r\n')

    expect((await call(harness.tenantAdminA, '/reports/:key/csv', 'from=bad', JOB_VIEWS_REPORT_KEY)).status).toBe(400)
    expect((await call(harness.tenantAdminA, '/reports/:key/csv', '', 'nope')).status).toBe(404)
  })

  it('answers 404 and offers nothing once the tenant switches the add-on off', async () => {
    await setAddOns(harness.tenantA.id, ['alerts'])
    try {
      expect((await call(harness.tenantAdminA, '/reports')).status).toBe(404)
      expect((await call(harness.tenantAdminA, '/reports/:key/csv', '', JOB_VIEWS_REPORT_KEY)).status).toBe(404)
      await expect(run(harness.tenantA.id, JOB_VIEWS_REPORT_KEY)).rejects.toMatchObject({ status: 404 })
      // Tenant B is unaffected.
      expect((await call(harness.tenantAdminB, '/reports')).status).toBe(200)
    } finally {
      await setAddOns(harness.tenantA.id, null)
    }
    expect((await call(harness.tenantAdminA, '/reports')).status).toBe(200)
  })

  it('lets a super admin choose the tenant', async () => {
    expect((await call(harness.superAdmin, '/reports')).status).toBe(400)
    expect((await call(harness.superAdmin, '/reports', `tenant=${harness.tenantB.id}`)).status).toBe(200)
  })
})
