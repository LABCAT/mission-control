import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from './index'
import { TAXONOMY_SLUGS } from './taxonomies'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

describe('payloadJobs', () => {
  it('keeps the existing config and custom keys when it registers itself', async () => {
    const result = await payloadJobs()(baseConfig)

    // mission-control: the users collection is extended (legacy password support, PJ-34), and
    // the taxonomies (PJ-16), plans (PJ-21) and email templates (PJ-27) are added.
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      ...TAXONOMY_SLUGS,
      'plans',
      'email-templates',
    ])
    expect(result.collections?.[0]?.fields.map((f) => ('name' in f ? f.name : null))).toContain(
      'legacyPasswordHash',
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

  it('uses the configured email templates slug', async () => {
    const result = await payloadJobs({ emailTemplatesSlug: 'tenant-emails' })(baseConfig)

    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      ...TAXONOMY_SLUGS,
      'plans',
      'tenant-emails',
    ])
  })

  it('does not register a second collection when the slug already exists', async () => {
    const existing = { slug: 'email-templates', fields: [] }

    const result = await payloadJobs()({
      ...baseConfig,
      collections: [...(baseConfig.collections ?? []), existing],
    } as unknown as Config)

    expect(result.collections?.filter((collection) => collection.slug === 'email-templates')).toEqual([
      existing,
    ])
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
})
