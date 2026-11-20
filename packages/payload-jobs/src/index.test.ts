import type { CollectionConfig, Config, Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { ALERT_SUBSCRIPTIONS_SLUG } from './alert-subscriptions'
import type { MissionControlUser } from './access'
import { DASHBOARD_COMPONENT_PATH } from './admin'
import { SITE_MANAGER_NAV_COLLECTIONS, siteManagerVisibleCollections } from './admin/nav'
import { EXPIRE_PLACEMENTS_TASK, jobsTenantCollections, payloadJobs } from './index'
import { TAXONOMY_SLUGS } from './taxonomies'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

const multiConfig = {
  collections: [
    { slug: 'users', fields: [] },
    { slug: 'tenants', fields: [] },
  ],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

// The description sits in the Details tab of the job edit view (PJ-30).
const description = async (config: Config) =>
  (await payloadJobs()(config)).collections
    ?.find((collection) => collection.slug === 'jobs')
    ?.fields.flatMap((field) => (field.type === 'tabs' ? field.tabs.flatMap((tab) => tab.fields) : [field]))
    .find((field) => 'name' in field && field.name === 'description')?.type

const taskSlugs = (config: Config) => (config.jobs?.tasks ?? []).map((task) => task.slug)

describe('payloadJobs', () => {
  it('keeps the existing config collections and custom keys when it registers itself', async () => {
    const result = await payloadJobs()(baseConfig)

    // mission-control: the users collection is extended (legacy password support PJ-34,
    // organisation relation PJ-18), and locations (PJ-17), organisations (PJ-18), alerts
    // (PJ-26), the taxonomies (PJ-16), plans (PJ-21) and coupons (PJ-22) are added.
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      ALERT_SUBSCRIPTIONS_SLUG,
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
      'jobs',
      'coupons',
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
        slugs: { jobs: 'jobs', tenants: 'tenants' },
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
        slugs: { jobs: 'jobs', tenants: 'tenants' },
        tenancy: 'single',
      },
    })
  })

  it('adds coupons only when the feature is on', async () => {
    const on = await payloadJobs()(baseConfig)
    const off = await payloadJobs({ features: { coupons: false } })(baseConfig)

    expect(on.collections?.map((collection) => collection.slug)).toContain('coupons')
    expect(off.collections?.map((collection) => collection.slug)).not.toContain('coupons')
  })

  it('adds jobs with placements, and the daily task that expires them, keeping host tasks', async () => {
    const withHostTask = {
      ...baseConfig,
      jobs: { tasks: [{ handler: () => ({ output: {} }), slug: 'heartbeat' }] },
    } as unknown as Config

    const result = await payloadJobs()(withHostTask)
    const jobs = result.collections?.find((collection) => collection.slug === 'jobs')

    expect(jobs?.fields.some((field) => 'name' in field && field.name === 'placements')).toBe(true)
    expect(taskSlugs(result)).toEqual(['heartbeat', EXPIRE_PLACEMENTS_TASK])
  })

  it('gives a site manager a cut-down nav and a dashboard of their own @S-117', async () => {
    const result = await payloadJobs({ accountAuth: false, tenancy: 'multi' })(multiConfig)
    const dashboard = result.admin?.components?.beforeDashboard ?? []

    expect(dashboard).toEqual([{ path: DASHBOARD_COMPONENT_PATH }])
    // Platform collections drop out of a site manager's menu, tenant content stays.
    const siteManager = {
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: 1 }],
    } as MissionControlUser
    const visible = siteManagerVisibleCollections(result, siteManager)

    expect(visible).toEqual(expect.arrayContaining(['jobs', 'organisations', 'plans', 'users']))
    expect(visible).not.toContain('tenants')
    // A super admin keeps every collection.
    expect(siteManagerVisibleCollections(result, { role: 'super-admin' })).toEqual(
      result.collections?.map((collection) => collection.slug),
    )
  })

  it('leaves the admin alone in single-tenant mode and when switched off', async () => {
    const single = await payloadJobs()(baseConfig)
    const off = await payloadJobs({ siteManagerAdmin: false, accountAuth: false, tenancy: 'multi' })(
      multiConfig,
    )

    expect(single.admin?.components?.beforeDashboard).toBeUndefined()
    expect(off.admin?.components?.beforeDashboard).toBeUndefined()
    expect(siteManagerVisibleCollections(off, { role: 'user', tenants: [{ role: 'tenant-admin', tenant: 1 }] })).toEqual(
      off.collections?.map((collection) => collection.slug),
    )
  })

  it('keeps a host collection in the menu when the host asks for it', async () => {
    const withMedia = {
      collections: [...(multiConfig.collections ?? []), { slug: 'media', fields: [] }],
      custom: {},
      secret: 'test',
    } as unknown as Config
    const result = await payloadJobs({
      accountAuth: false,
      siteManagerAdmin: { collections: [...SITE_MANAGER_NAV_COLLECTIONS, 'media'] },
      tenancy: 'multi',
    })(withMedia)

    expect(
      siteManagerVisibleCollections(result, { role: 'user', tenants: [{ role: 'tenant-admin', tenant: 1 }] }),
    ).toContain('media')
  })

  it('uses a rich-text job description only when the host has an editor', async () => {
    expect(await description(baseConfig)).toBe('textarea')
    expect(await description({ ...baseConfig, editor: {} } as unknown as Config)).toBe('richText')
  })
})

const deny = () => false

const OVERRIDES = {
  addOns: { slug: 'extras' },
  alertSubscriptions: { slug: 'subscribers' },
  coupons: { slug: 'vouchers' },
  jobCategories: { slug: 'categories' },
  jobs: { slug: 'vacancies' },
  jobTypes: { slug: 'employment-types' },
  locations: { slug: 'job-locations' },
  organisations: { slug: 'employers' },
  plans: { slug: 'packages' },
  salaryBands: { slug: 'salaries' },
} as const

/** Every `relationTo` in a collection, including fields nested in rows, tabs and collapsibles. */
const relationTargets = (collection: CollectionConfig): string[] => {
  const targets: string[] = []
  const visit = (fields: Field[] | undefined) => {
    for (const field of fields ?? []) {
      const relation = field as { fields?: Field[]; relationTo?: unknown; tabs?: { fields: Field[] }[] }
      if (relation.relationTo !== undefined) {
        targets.push(...[relation.relationTo].flat().map(String))
      }
      if (relation.fields) visit(relation.fields)
      for (const tab of relation.tabs ?? []) visit(tab.fields)
    }
  }

  visit(collection.fields)
  return targets
}

describe('collection slug overrides', () => {
  it('renames every plugin collection, and every relationship points at the resolved slug', async () => {
    const result = await payloadJobs({ collections: OVERRIDES })(baseConfig)
    const slugs = (result.collections ?? []).map((collection) => collection.slug)

    expect(slugs).toEqual([
      'users',
      'job-locations',
      'employers',
      'subscribers',
      'categories',
      'employment-types',
      'salaries',
      'packages',
      'extras',
      'vacancies',
      'vouchers',
    ])

    const targets = new Set(
      (result.collections ?? []).flatMap((collection) => relationTargets(collection)),
    )

    // No default plugin slug survives a rename, and each relation resolves to its new name.
    for (const slug of ['locations', 'organisations', 'job-categories', 'job-types', 'salary-bands', 'plans', 'add-ons', 'jobs']) {
      expect(targets).not.toContain(slug)
    }
    expect(targets).toEqual(
      new Set(['job-locations', 'employers', 'categories', 'employment-types', 'salaries', 'packages', 'extras']),
    )

    const users = result.collections?.find((collection) => collection.slug === 'users')
    expect(relationTargets(users!)).toContain('employers')
  })

  it('exports the tenant-scoped slugs under the same overrides', () => {
    expect(jobsTenantCollections({ collections: OVERRIDES })).toEqual([
      'job-locations',
      'employers',
      'categories',
      'employment-types',
      'salaries',
      'extras',
      'packages',
      'subscribers',
      'vacancies',
      'vouchers',
    ])
  })

  it('honours the legacy jobsSlug option in the tenant-collection helper', () => {
    const slugs = jobsTenantCollections({ jobsSlug: 'vacancies' })

    expect(slugs).toContain('vacancies')
    expect(slugs).not.toContain('jobs')
  })

  it('merges per-collection access overrides over the operation defaults', async () => {
    const defaults = await payloadJobs()(baseConfig)
    const result = await payloadJobs({
      collections: {
        jobs: { access: { read: deny } },
        locations: { access: { create: deny } },
      },
    })(baseConfig)

    const defaultJobs = defaults.collections?.find((collection) => collection.slug === 'jobs')
    const jobs = result.collections?.find((collection) => collection.slug === 'jobs')
    const defaultLocations = defaults.collections?.find(
      (collection) => collection.slug === 'locations',
    )
    const locations = result.collections?.find((collection) => collection.slug === 'locations')

    expect(jobs?.access?.read).toBe(deny)
    expect(locations?.access?.create).toBe(deny)

    // The operations the host did not override keep the plugin's default behaviour.
    const args = {
      req: { user: { id: 1, role: 'user', tenants: [{ role: 'editor', tenant: 1 }] } },
    } as never
    expect(await jobs?.access?.update?.(args)).toEqual(await defaultJobs?.access?.update?.(args))
    expect(await locations?.access?.read?.(args)).toEqual(
      await defaultLocations?.access?.read?.(args),
    )
  })
})
