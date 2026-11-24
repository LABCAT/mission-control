import type { CollectionConfig, Config, Field } from 'payload'
import { describe, expect, it } from 'vitest'

import type { MissionControlUser } from './access'
import { DASHBOARD_COMPONENT_PATH } from './admin'
import { SITE_MANAGER_NAV_COLLECTIONS, siteManagerVisibleCollections } from './admin/nav'
import { EXPIRE_PLACEMENTS_TASK, jobsTenantCollections, payloadJobs } from './index'
import { DEFAULT_PAYLOAD_JOBS_SLUGS } from './slugs'
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
    // organisation relation PJ-18), and locations (PJ-17), organisations (PJ-18), pages and
    // menus (PJ-103), the taxonomies (PJ-16), plans (PJ-21), coupons (PJ-22),
    // applications (PJ-25), orders (PJ-23) and the credit ledger (PJ-24) are added.
    expect(result.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      'pages',
      'menus',
      'site-settings',
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
      'jobs',
      'coupons',
      'application-files',
      'applications',
      'orders',
      'credit-ledger',
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
        features: { applications: true, credits: true, coupons: true, pages: true },
        paymentProviders: ['invoice'],
        registry: expect.any(Object),
        slugs: { ...DEFAULT_PAYLOAD_JOBS_SLUGS, tenants: 'tenants' },
        tenancy: 'single',
      },
    })
  })

  it('returns the config untouched when disabled', async () => {
    expect(await payloadJobs({ enabled: false })(baseConfig)).toBe(baseConfig)
  })

  it('resolves feature toggles and records them in the config', async () => {
    const result = await payloadJobs({
      features: { applications: true, credits: true, coupons: false, pages: true },
    })(baseConfig)

    expect(result.custom).toEqual({
      existing: true,
      payloadJobs: {
        enabled: true,
        features: { applications: true, credits: true, coupons: false, pages: true },
        paymentProviders: ['invoice'],
        registry: expect.any(Object),
        slugs: { ...DEFAULT_PAYLOAD_JOBS_SLUGS, tenants: 'tenants' },
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

  it('adds the credit ledger, the History endpoint and the cancel refund only when credits are on @S-149', async () => {
    const on = await payloadJobs()(baseConfig)
    const off = await payloadJobs({ features: { credits: false } })(baseConfig)
    const find = (config: typeof on, slug: string) => config.collections?.find((collection) => collection.slug === slug)
    const endpointPaths = (config: typeof on) =>
      ((find(config, 'organisations')?.endpoints || []) as { path: string }[]).map((endpoint) => endpoint.path)

    expect(find(on, 'credit-ledger')).toBeDefined()
    expect(find(off, 'credit-ledger')).toBeUndefined()
    expect(endpointPaths(on)).toContain('/:id/history')
    expect(endpointPaths(off)).not.toContain('/:id/history')
    expect(find(on, 'jobs')?.hooks?.afterChange?.length).toBe((find(off, 'jobs')?.hooks?.afterChange?.length ?? 0) + 1)
  })

  it('keeps organisations, jobs and orders that credit rows point at @S-149', async () => {
    const result = await payloadJobs()(baseConfig)
    const req = { context: {}, payload: { collections: { 'credit-ledger': {} }, count: async () => ({ totalDocs: 1 }) } }
    for (const slug of ['organisations', 'jobs', 'orders']) {
      const guards = (result.collections?.find((collection) => collection.slug === slug)?.hooks?.beforeDelete ??
        []) as ((args: unknown) => Promise<void>)[]
      const messages = await Promise.all(
        guards.map((guard) =>
          Promise.resolve(guard({ collection: { slug }, id: 1, req })).then(
            () => '',
            (error: { data?: { errors?: { message: string }[] } }) => error.data?.errors?.[0]?.message ?? '',
          ),
        ),
      )
      expect(messages.some((message) => /credit movement/.test(message))).toBe(true)
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

  it('keeps renamed job-board collections in a site manager’s menu @S-117', async () => {
    const result = await payloadJobs({
      accountAuth: false,
      collections: OVERRIDES,
      tenancy: 'multi',
    })(multiConfig)

    const visible = siteManagerVisibleCollections(result, {
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: 1 }],
    })

    // Every renamed collection is the site manager's own content, so all of them stay.
    expect(visible).toEqual(
      expect.arrayContaining([
        'vacancies',
        'employers',
        'job-locations',
        'categories',
        'employment-types',
        'salaries',
        'packages',
        'extras',
        'vouchers',
        'content-pages',
        'navigation',
      ]),
    )
    // The platform collections stay hidden, and no default slug leaks back in.
    expect(visible).not.toContain('tenants')
    expect(visible).not.toContain('subscribers')
    for (const slug of [
      'jobs',
      'organisations',
      'locations',
      'plans',
      'add-ons',
      'coupons',
      'pages',
      'menus',
      'job-categories',
      'job-types',
      'salary-bands',
    ]) {
      expect(visible).not.toContain(slug)
    }
  })

  it('honours the legacy jobsSlug option in the site manager’s menu @S-117', async () => {
    const result = await payloadJobs({
      accountAuth: false,
      jobsSlug: 'vacancies',
      tenancy: 'multi',
    })(multiConfig)

    const visible = siteManagerVisibleCollections(result, {
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: 1 }],
    })

    expect(visible).toContain('vacancies')
    expect(visible).not.toContain('jobs')
  })

  it('records every collection slug for the dashboard, so a later collection needs no change here', async () => {
    const result = await payloadJobs({ accountAuth: false, collections: OVERRIDES, tenancy: 'multi' })(
      multiConfig,
    )
    const recorded = result.custom?.payloadJobs as { slugs: Record<string, string> }

    // Every recorded slug is a collection the plugin registered, under its resolved name,
    // including main's real orders collection (PJ-23).
    const registered = (result.collections ?? []).map((collection) => collection.slug)
    const { tenants: _tenants, ...owned } = recorded.slugs

    expect(registered).toEqual(expect.arrayContaining(Object.values(owned)))
    expect(registered).toContain(recorded.slugs.orders)
    expect(recorded.slugs).toMatchObject({ jobs: 'vacancies', organisations: 'employers' })
    // The host's own tenant collection keeps its slug too.
    expect(recorded.slugs.tenants).toBe('tenants')
  })

  it('uses a rich-text job description only when the host has an editor', async () => {
    expect(await description(baseConfig)).toBe('textarea')
    expect(await description({ ...baseConfig, editor: {} } as unknown as Config)).toBe('richText')
  })
})

const deny = () => false

const OVERRIDES = {
  addOns: { slug: 'extras' },
  coupons: { slug: 'vouchers' },
  creditLedger: { slug: 'credit-moves' },
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
      'content-pages',
      'navigation',
      'site-settings',
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
      'credit-moves',
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
      'vacancies',
      'vouchers',
      'application-files',
      'applications',
      'purchases',
      'credit-moves',
      'site-settings',
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
