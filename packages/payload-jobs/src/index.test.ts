import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from './index'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

describe('payloadJobs', () => {
  it('keeps the existing config and custom keys when it registers itself', async () => {
    const result = await payloadJobs()(baseConfig)

    expect(result.collections).toBe(baseConfig.collections)
    expect(result.globals?.[0]?.slug).toBe('job-board-settings')
    expect(result.custom).toEqual({ existing: true, payloadJobs: { enabled: true, tenancy: 'single' } })
  })

  it('returns the config untouched when disabled', async () => {
    expect(await payloadJobs({ enabled: false })(baseConfig)).toBe(baseConfig)
  })
})
