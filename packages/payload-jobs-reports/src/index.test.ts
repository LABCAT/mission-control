import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { getPayloadJobsRegistry, payloadJobs } from '@mission-control/payload-jobs'

import { payloadJobsReports, REPORTS_ADD_ON_KEY } from './index'

const base = { collections: [{ slug: 'users', fields: [] }], secret: 'x' } as unknown as Config

describe('payload-jobs-reports plugin @S-147 @S-104 @S-105', () => {
  it('registers the add-on and both reports, adds no collections, one admin view and the endpoints', async () => {
    const core = await payloadJobs()(base)
    const result = await payloadJobsReports()(core)

    expect(result.collections).toBe(core.collections)
    const registry = getPayloadJobsRegistry(result)
    expect(registry.addOns.has(REPORTS_ADD_ON_KEY)).toBe(true)
    expect(registry.reports.list().map((report) => report.key)).toEqual(['jobs-orders-by-month', 'job-views'])
    expect(registry.reports.list().every((report) => report.addOn === REPORTS_ADD_ON_KEY)).toBe(true)
    expect(result.endpoints?.map((endpoint) => endpoint.path)).toEqual(['/reports', '/reports/:key/csv'])
    expect(result.admin?.components?.views?.reports).toMatchObject({ path: '/reports' })
  })

  it('registers only once, and can be switched off in the config', async () => {
    const core = await payloadJobs()(base)
    await payloadJobsReports()(core)

    expect(() => payloadJobsReports()(core)).toThrow(/already registered/)
    expect(await payloadJobsReports({ enabled: false })(core)).toBe(core)
  })
})
