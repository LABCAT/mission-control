import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { getPayloadJobsRegistry, payloadJobs } from '@mission-control/payload-jobs'

import { payloadJobsReports, REPORTS_ADD_ON_KEY } from './index'

const base = { collections: [{ slug: 'users', fields: [] }], secret: 'x' } as unknown as Config

describe('payload-jobs-reports skeleton @S-147', () => {
  it('registers the add-on, adds no collections and no reports yet', async () => {
    const core = await payloadJobs()(base)
    const result = await payloadJobsReports()(core)

    expect(result.collections).toBe(core.collections)
    const registry = getPayloadJobsRegistry(result)
    expect(registry.addOns.has(REPORTS_ADD_ON_KEY)).toBe(true)
    expect(registry.reports.list()).toEqual([])
  })

  it('registers only once, and can be switched off in the config', async () => {
    const core = await payloadJobs()(base)
    await payloadJobsReports()(core)

    expect(() => payloadJobsReports()(core)).toThrow(/already registered/)
    expect(await payloadJobsReports({ enabled: false })(core)).toBe(core)
  })
})
