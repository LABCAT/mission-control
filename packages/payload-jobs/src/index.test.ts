import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { EXPIRE_PLACEMENTS_TASK, jobPlacementsField, payloadJobs } from './index'
import { TAXONOMY_SLUGS } from './taxonomies'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

describe('payloadJobs', () => {
  it('keeps the existing config and custom keys when it registers itself', async () => {
    const result = await payloadJobs()(baseConfig)

    // mission-control: the users collection is extended (legacy password support PJ-34,
    // organisation relation PJ-18), and locations (PJ-17), organisations (PJ-18), the
    // taxonomies (PJ-16) and plans (PJ-21) are added.
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
    ])
    expect(result.collections?.[0]?.fields.map((f) => ('name' in f ? f.name : null))).toContain(
      'legacyPasswordHash',
    )
    expect(result.collections?.[0]?.fields.map((f) => ('name' in f ? f.name : null))).toContain(
      'organisation',
    )
    expect(result.collections?.[0]?.hooks?.beforeOperation).toHaveLength(1)
    expect(result.globals?.[0]?.slug).toBe('job-board-settings')
    expect(result.custom).toEqual({
      existing: true,
      payloadJobs: {
        enabled: true,
        features: { applications: true, alerts: true, credits: true, coupons: true },
        tenancy: 'single',
      },
    })
  })

  it('returns the config untouched when disabled', async () => {
    expect(await payloadJobs({ enabled: false })(baseConfig)).toBe(baseConfig)
  })

  it('resolves feature toggles and records them in the config', async () => {
    const result = await payloadJobs({
      features: { applications: true, alerts: false, credits: true, coupons: false },
    })(baseConfig)

    expect(result.custom).toEqual({
      existing: true,
      payloadJobs: {
        enabled: true,
        features: { applications: true, alerts: false, credits: true, coupons: false },
        tenancy: 'single',
      },
    })
  })

  it('registers the placement expiry task only once a jobs collection has placements (PJ-19)', async () => {
    const taskSlugs = (config: Config) => (config.jobs?.tasks ?? []).map((task) => task.slug)
    const withJobs = (fields: unknown[]) =>
      ({
        ...baseConfig,
        collections: [...(baseConfig.collections ?? []), { slug: 'jobs', fields }],
        jobs: { tasks: [{ handler: () => ({ output: {} }), slug: 'heartbeat' }] },
      }) as unknown as Config

    expect(taskSlugs(await payloadJobs()(baseConfig))).toEqual([])
    expect(taskSlugs(await payloadJobs()(withJobs([{ name: 'title', type: 'text' }])))).toEqual(['heartbeat'])
    expect(taskSlugs(await payloadJobs()(withJobs([jobPlacementsField()])))).toEqual([
      'heartbeat',
      EXPIRE_PLACEMENTS_TASK,
    ])
  })
})
