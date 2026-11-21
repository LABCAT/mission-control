import type { CollectionConfig, Config, Field } from 'payload'
import { describe, expect, it } from 'vitest'

import { ALERT_SUBSCRIPTIONS_SLUG } from './alert-subscriptions'
import { EXPIRE_PLACEMENTS_TASK, jobsTenantCollections, payloadJobs } from './index'
import { TAXONOMY_SLUGS } from './taxonomies'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  custom: { existing: true },
  secret: 'test',
} as unknown as Config

describe('payloadJobs', () => {
  it('keeps the existing config collections and custom keys when it registers itself', async () => {
    const result = await payloadJobs()(baseConfig)

    // mission-control: the users collection is extended (legacy password support PJ-34,
    // organisation relation PJ-18), and locations (PJ-17), organisations (PJ-18), pages and
    // menus (PJ-103), alerts (PJ-26), the taxonomies (PJ-16), plans (PJ-21), coupons (PJ-22),
    // applications (PJ-25) and orders (PJ-23) are added.
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      'pages',
      'menus',
      ALERT_SUBSCRIPTIONS_SLUG,
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
      'jobs',
      'coupons',
      'application-files',
      'applications',
      'orders',
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
        features: { applications: true, alerts: true, credits: true, coupons: true, pages: true },
        paymentProviders: ['invoice'],
        tenancy: 'single',
      },
    })
  })

  it('returns the config untouched when disabled', async () => {
    expect(await payloadJobs({ enabled: false })(baseConfig)).toBe(baseConfig)
  })

  it('resolves feature toggles and records them in the config', async () => {
    const result = await payloadJobs({
      features: { applications: true, alerts: false, credits: true, coupons: false, pages: true },
    })(baseConfig)

    expect(result.custom).toEqual({
      existing: true,
      payloadJobs: {
        enabled: true,
        features: { applications: true, alerts: false, credits: true, coupons: false, pages: true },
        paymentProviders: ['invoice'],
        tenancy: 'single',
      },
    })
  })

  it('registers payment providers on top of invoice and checks them @S-146', async () => {
    const result = await payloadJobs({ orders: { paymentProviders: [{ key: 'stripe', label: 'Card' }] } })(baseConfig)

    const custom = result.custom as { payloadJobs: { paymentProviders: string[] } }
    expect(custom.payloadJobs.paymentProviders).toEqual([
      'invoice',
      'stripe',
    ])
    await expect(
      Promise.resolve().then(() =>
        payloadJobs({ orders: { paymentProviders: [{ key: 'invoice', label: 'Again' }] } })(baseConfig),
      ),
    ).rejects.toThrow(/registered twice/)
  })

  it('lets an organisation owner (organisationRole) update its orders by default @S-146', async () => {
    const result = await payloadJobs({ tenancy: 'multi' })({
      ...baseConfig,
      collections: [
        { slug: 'users', fields: [], auth: { verify: true } },
        { slug: 'tenants', fields: [] },
      ],
    } as unknown as Config)
    const orders = result.collections?.find((collection) => collection.slug === 'orders')
    const update = (user: Record<string, unknown>) =>
      orders?.access?.update?.({ data: {}, req: { context: {}, user } } as never)
    const employer = { id: 3, organisation: 9, role: 'user', tenants: [{ role: 'employer', tenant: 1 }] }

    expect(await update({ ...employer, organisationRole: 'owner' })).toEqual({
      and: [{ organisation: { equals: 9 } }, { tenant: { in: [1] } }],
    })
    expect(await update({ ...employer, organisationRole: 'member' })).toBe(false)
  })

  it('keeps ordered organisations and jobs from being deleted @S-146', async () => {
    const result = await payloadJobs()(baseConfig)
    const hooksOf = (slug: string) =>
      result.collections?.find((collection) => collection.slug === slug)?.hooks?.beforeDelete ?? []

    // The order guard runs first on each; it refuses while any order points at the document.
    const req = { payload: { collections: { orders: {} }, count: async () => ({ totalDocs: 1 }) } }
    for (const slug of ['organisations', 'jobs']) {
      const [guard] = hooksOf(slug) as ((args: unknown) => Promise<void>)[]
      await expect(guard({ collection: { slug }, id: 1, req })).rejects.toThrow()
    }
  })

  it('adds coupons only when the feature is on', async () => {
    const on = await payloadJobs()(baseConfig)
    const off = await payloadJobs({ features: { coupons: false } })(baseConfig)

    expect(on.collections?.map((collection) => collection.slug)).toContain('coupons')
    expect(off.collections?.map((collection) => collection.slug)).not.toContain('coupons')
    // Orders stay on, without a relationship to the missing collection (PJ-23).
    const orders = off.collections?.find((collection) => collection.slug === 'orders')
    expect(orders).toBeDefined()
    expect(relationTargets(orders!)).not.toContain('coupons')
  })

  it('adds jobs with placements, and the daily task that expires them, keeping host tasks', async () => {
    const taskSlugs = (config: Config) => (config.jobs?.tasks ?? []).map((task) => task.slug)
    const withHostTask = {
      ...baseConfig,
      jobs: { tasks: [{ handler: () => ({ output: {} }), slug: 'heartbeat' }] },
    } as unknown as Config

    const result = await payloadJobs()(withHostTask)
    const jobs = result.collections?.find((collection) => collection.slug === 'jobs')

    expect(jobs?.fields.some((field) => 'name' in field && field.name === 'placements')).toBe(true)
    expect(taskSlugs(result)).toEqual(['heartbeat', EXPIRE_PLACEMENTS_TASK])
  })

  it('uses a rich-text job description only when the host has an editor', async () => {
    const description = async (config: Config) =>
      (await payloadJobs()(config)).collections
        ?.find((collection) => collection.slug === 'jobs')
        ?.fields.find((field) => 'name' in field && field.name === 'description')?.type

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
  menus: { slug: 'navigation' },
  orders: { slug: 'purchases' },
  organisations: { slug: 'employers' },
  pages: { slug: 'content-pages' },
  plans: { slug: 'packages' },
  salaryBands: { slug: 'salaries' },
} as const

/** Every `relationTo` in a collection, including fields nested in rows and collapsibles. */
const relationTargets = (collection: CollectionConfig): string[] => {
  const targets: string[] = []
  const visit = (fields: Field[] | undefined) => {
    for (const field of fields ?? []) {
      const relation = field as { fields?: Field[]; relationTo?: unknown }
      if (relation.relationTo !== undefined) {
        targets.push(...[relation.relationTo].flat().map(String))
      }
      if (relation.fields) visit(relation.fields)
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
      'content-pages',
      'navigation',
      'subscribers',
      'categories',
      'employment-types',
      'salaries',
      'packages',
      'extras',
      'vacancies',
      'vouchers',
      'application-files',
      'applications',
      'purchases',
    ])

    const targets = new Set(
      (result.collections ?? []).flatMap((collection) => relationTargets(collection)),
    )

    // No default plugin slug survives a rename, and each relation resolves to its new name.
    for (const slug of ['locations', 'organisations', 'pages', 'menus', 'job-categories', 'job-types', 'salary-bands', 'plans', 'add-ons', 'jobs', 'coupons']) {
      expect(targets).not.toContain(slug)
    }
    // The pages' parent and menus' page items follow the renamed pages collection.
    expect(targets).toEqual(
      new Set([
        'job-locations',
        'employers',
        'content-pages',
        'categories',
        'employment-types',
        'salaries',
        'packages',
        'extras',
        // Applications relate to the renamed jobs and organisations, their own private files
        // (a slug of their own, not overridable), and the applicant's users collection.
        'vacancies',
        'application-files',
        'users',
        // Orders relate to organisations, plans, add-ons, coupons, jobs and users; jobs to orders.
        'vouchers',
        'purchases',
      ]),
    )

    const users = result.collections?.find((collection) => collection.slug === 'users')
    expect(relationTargets(users!)).toContain('employers')
  })

  it('exports the tenant-scoped slugs under the same overrides', () => {
    expect(jobsTenantCollections({ collections: OVERRIDES })).toEqual([
      'job-locations',
      'employers',
      'content-pages',
      'navigation',
      'categories',
      'employment-types',
      'salaries',
      'extras',
      'packages',
      'subscribers',
      'vacancies',
      'vouchers',
      'application-files',
      'applications',
      'purchases',
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
