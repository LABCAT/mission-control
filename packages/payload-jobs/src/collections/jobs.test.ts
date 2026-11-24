import type { CollectionConfig, Field, PayloadRequest } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from '../add-ons'
import { liveJobsWhere } from '../job-status'
import { endOfLocalDayAfter } from '../local-time'
import { expireJobPlacementsTask } from '../placements'
import { planCollection, withPlanRestrictionGuards } from '../plans'
import { hashSiteKey } from '../site-keys'
import { taxonomyCollections } from '../taxonomies'
import { bootTestPayload, type TestHarness } from '../test'
import { JOBS_SLUG, jobsCollection } from './jobs'
import { locationsCollection } from './locations'
import { organisationsCollection } from './organisations'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'isAggregate', type: 'checkbox', defaultValue: false },
]

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { read: () => false },
  fields: [
    { name: 'keyHash', type: 'text', index: true },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants' },
  ],
  versions: false,
}

const anonymousReq = async (key?: string): Promise<PayloadRequest> =>
  ({ headers: new Headers(key ? { 'x-site-key': key } : {}) }) as PayloadRequest

// oxlint-disable-next-line unicorn/no-array-sort
const ascending = (ids: number[]): number[] => [...ids].sort((a, b) => a - b)

const DAY = 24 * 60 * 60 * 1000

type Actor = {
  collection: 'users'
  id: number
  organisation?: number
  role: 'super-admin' | 'user'
  tenants: { role: string; tenant: number }[]
}

const as = (user: unknown) => ({ overrideAccess: false, user: user as never })

const at = (days: number) => new Date(Date.now() + days * DAY).toISOString()

describe('jobs', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}
  const users: Record<'editorA' | 'employerA' | 'employerA2' | 'seekerA', Actor> = {} as never
  const siteKeyA = 'sk_test_jobs_a'

  const create = async (collection: string, data: Record<string, unknown>) =>
    ((await harness.payload.create({ collection, data, overrideAccess: true })) as { id: number }).id

  const job = (data: Record<string, unknown>) => create(JOBS_SLUG, { title: 'A job', ...data })

  const visible = async (args: { req?: PayloadRequest; user?: unknown }): Promise<number[]> => {
    try {
      const { docs } = await harness.payload.find({
        collection: JOBS_SLUG,
        depth: 0,
        limit: 200,
        overrideAccess: false,
        req: args.req,
        user: args.user as never,
      })
      return ascending(docs.map((doc) => Number(doc.id)))
    } catch (error) {
      if ((error as { status?: number }).status === 403) return []
      throw error
    }
  }

  const stored = async (id: number) =>
    (await harness.payload.findByID({ collection: JOBS_SLUG, depth: 0, id, overrideAccess: true })) as unknown as Record<
      string,
      unknown
    >

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ tenantScoped: true }),
      ],
      globalCollections: [SiteKeys],
      tenantData: (which) => ({ currency: which === 'A' ? 'VUV' : 'NZD' }),
      tenantFields,
    })
    const { tenantA, tenantB } = harness

    ids.orgA = await create('organisations', { name: 'Org A', slug: 'org-a', tenant: tenantA.id })
    ids.orgA2 = await create('organisations', { name: 'Org A2', slug: 'org-a2', tenant: tenantA.id })
    ids.orgB = await create('organisations', { name: 'Org B', slug: 'org-b', tenant: tenantB.id })
    ids.fullTimeA = await create('job-types', { name: 'Full time', slug: 'full-time', tenant: tenantA.id })
    ids.voluntaryA = await create('job-types', { isVolunteer: true, name: 'Voluntary', slug: 'voluntary', tenant: tenantA.id })
    ids.healthA = await create('job-categories', { name: 'Health', slug: 'health', tenant: tenantA.id })
    ids.healthB = await create('job-categories', { name: 'Health', slug: 'health', tenant: tenantB.id })
    ids.regularA = await create('plans', { durationDays: 30, key: 'regular', name: 'Regular', price: 5000, tenant: tenantA.id })
    ids.volunteerA = await create('plans', {
      durationDays: 60,
      isVolunteer: true,
      key: 'volunteer',
      name: 'Volunteer',
      price: 0,
      tenant: tenantA.id,
    })

    const makeUser = async (label: string, tenants: Actor['tenants'], organisation?: number): Promise<Actor> => {
      const id = await create('users', {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
      })
      return { collection: 'users', id, organisation, role: 'user', tenants }
    }
    users.editorA = await makeUser('editor-a', [{ role: 'editor', tenant: tenantA.id }])
    users.employerA = await makeUser('employer-a', [{ role: 'employer', tenant: tenantA.id }], ids.orgA)
    users.employerA2 = await makeUser('employer-a2', [{ role: 'employer', tenant: tenantA.id }], ids.orgA2)
    users.seekerA = await makeUser('seeker-a', [{ role: 'seeker', tenant: tenantA.id }], ids.orgA)

    const past = new Date(Date.now() - DAY).toISOString()
    ids.draftA = await job({ organisation: ids.orgA, status: 'draft', tenant: tenantA.id, title: 'Draft A' })
    ids.publishedA = await job({ organisation: ids.orgA, status: 'published', tenant: tenantA.id, title: 'Published A' })
    ids.expiredA = await job({ organisation: ids.orgA, status: 'published', tenant: tenantA.id, title: 'Expired A' })
    await harness.payload.update({ collection: JOBS_SLUG, data: { status: 'expired' }, id: ids.expiredA, overrideAccess: true })
    ids.staleA = await job({ expiresAt: past, organisation: ids.orgA, status: 'published', tenant: tenantA.id, title: 'Stale A' })
    ids.otherOrgA = await job({ organisation: ids.orgA2, status: 'draft', tenant: tenantA.id, title: 'Other org A' })
    ids.publishedB = await job({ organisation: ids.orgB, status: 'published', tenant: tenantB.id, title: 'Published B' })

    await create('site-keys', { keyHash: await hashSiteKey(siteKeyA), tenant: tenantA.id })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  describe('read access', () => {
    it('shows a site key only its tenant’s published and expired jobs', async () => {
      expect(await visible({ req: await anonymousReq(siteKeyA) })).toEqual(
        ascending([ids.publishedA, ids.expiredA, ids.staleA]),
      )
      expect(await visible({ req: await anonymousReq() })).toEqual([])
      expect(await visible({ req: await anonymousReq('sk_unknown') })).toEqual([])
    })

    it('shows an employer every job of their own organisation, and no one else’s', async () => {
      expect(await visible({ user: users.employerA })).toEqual(
        ascending([ids.draftA, ids.publishedA, ids.expiredA, ids.staleA]),
      )
      expect(await visible({ user: users.employerA2 })).toEqual([ids.otherOrgA])
    })

    it('shows staff their tenant only, and seekers nothing', async () => {
      const tenantA = await visible({ user: harness.tenantAdminA })
      expect(tenantA).toContain(ids.otherOrgA)
      expect(tenantA).not.toContain(ids.publishedB)
      expect(await visible({ user: users.editorA })).toEqual(tenantA)
      expect(await visible({ user: users.seekerA })).toEqual([])
      expect(await visible({ user: harness.tenantAdminB })).toEqual([ids.publishedB])
    })

    it('narrows readable jobs to live ones with liveJobsWhere', async () => {
      const { docs } = await harness.payload.find({
        collection: JOBS_SLUG,
        depth: 0,
        overrideAccess: false,
        req: await anonymousReq(siteKeyA),
        where: liveJobsWhere(),
      })
      expect(docs.map((doc) => Number(doc.id))).toEqual([ids.publishedA])
    })
  })

  const read = async (args: { req?: PayloadRequest; user?: unknown }) =>
    (await harness.payload.findByID({
      collection: JOBS_SLUG,
      depth: 0,
      id: ids.privateA,
      overrideAccess: false,
      req: args.req,
      user: args.user as never,
    })) as unknown as Record<string, unknown> & { placements: Record<string, unknown>[] }

  describe('private fields', () => {
    const PRIVATE = ['applicationsRecipient', 'plan', 'views'] as const

    beforeAll(async () => {
      ids.privateA = await job({
        applicationsRecipient: 'hr@org-a.example.invalid',
        organisation: ids.orgA,
        placements: [{ addOn: null, expiresAt: at(5), placement: 'featured-in-listings', startsAt: at(-1) }],
        plan: ids.regularA,
        status: 'published',
        tenant: harness.tenantA.id,
        title: 'Private fields A',
      })
    })

    it('hides the applications email, plan, views and placement add-on from site keys', async () => {
      const req = await anonymousReq(siteKeyA)
      const doc = await read({ req })
      expect(doc.title).toBe('Private fields A')
      for (const field of PRIVATE) expect(doc).not.toHaveProperty(field)
      expect(doc.placements[0].placement).toBe('featured-in-listings')
      expect(doc.placements[0]).toHaveProperty('expiresAt')
      expect(doc.placements[0]).not.toHaveProperty('addOn')

      const { docs } = await harness.payload.find({ collection: JOBS_SLUG, depth: 0, overrideAccess: false, req })
      expect(docs.length).toBeGreaterThan(0)
      for (const listed of docs) expect(listed).not.toHaveProperty('applicationsRecipient')
    })

    it('refuses to filter public reads by a private field (no guessing the email)', async () => {
      await expect(
        harness.payload.find({
          collection: JOBS_SLUG,
          overrideAccess: false,
          req: await anonymousReq(siteKeyA),
          where: { applicationsRecipient: { equals: 'hr@org-a.example.invalid' } },
        }),
      ).rejects.toThrow()
    })

    it('gives anonymous callers without a key nothing at all', async () => {
      await expect(read({ req: await anonymousReq() })).rejects.toThrow()
    })

    it('shows them to the owning employer and to staff, but never to seekers or other employers', async () => {
      for (const user of [users.employerA, users.editorA]) {
        const doc = await read({ user })
        expect(doc.applicationsRecipient).toBe('hr@org-a.example.invalid')
        expect(doc.plan).toBe(ids.regularA)
        expect(doc.views).toBe(0)
        expect(doc.placements[0]).toHaveProperty('addOn')
      }
      await expect(read({ user: users.employerA2 })).rejects.toThrow()
      await expect(read({ user: users.seekerA })).rejects.toThrow()
    })
  })

  describe('employers', () => {
    it('create drafts for their own organisation, without setting staff-only fields', async () => {
      const id = (
        (await harness.payload.create({
          collection: JOBS_SLUG,
          data: {
            organisation: ids.orgA,
            plan: ids.regularA,
            publishedAt: new Date().toISOString(),
            tenant: harness.tenantA.id,
            title: 'Accountant, Port Vila',
            views: 99,
          },
          ...as(users.employerA),
        })) as { id: number }
      ).id

      expect(await stored(id)).toMatchObject({
        companyName: 'Org A',
        plan: null,
        publishedAt: null,
        slug: 'accountant-port-vila',
        status: 'draft',
        views: 0,
      })
    })

    it('can’t post for another organisation, in another tenant, or straight to published', async () => {
      for (const data of [
        { organisation: ids.orgA2, tenant: harness.tenantA.id },
        { organisation: ids.orgB, tenant: harness.tenantB.id },
        { organisation: ids.orgA, status: 'published', tenant: harness.tenantA.id },
      ]) {
        await expect(
          harness.payload.create({ collection: JOBS_SLUG, data: { title: 'Nope', ...data }, ...as(users.employerA) }),
        ).rejects.toThrow()
      }
    })

    it('edit and submit their drafts, but can’t publish, edit live jobs, move or delete them', async () => {
      const id = await job({ organisation: ids.orgA, status: 'draft', tenant: harness.tenantA.id })
      const update = (target: number, data: Record<string, unknown>) =>
        harness.payload.update({ collection: JOBS_SLUG, data, id: target, ...as(users.employerA) })

      await update(id, { title: 'Better title' })
      await update(id, { status: 'pending' })
      expect(await stored(id)).toMatchObject({ status: 'pending', title: 'Better title' })

      await expect(update(id, { status: 'published' })).rejects.toThrow()
      await expect(update(id, { organisation: ids.orgA2 })).rejects.toThrow()
      await expect(update(ids.publishedA, { title: 'Changed live' })).rejects.toThrow()
      await expect(
        harness.payload.delete({ collection: JOBS_SLUG, id, ...as(users.employerA) }),
      ).rejects.toThrow()

      await update(id, { status: 'cancelled' })
      await expect(update(id, { status: 'draft' })).rejects.toThrow()
    })
  })

  describe('staff and the state machine', () => {
    it('publish for the plan’s duration, end early, and relist with a new publish date @S-190', async () => {
      const id = await job({ organisation: ids.orgA, plan: ids.regularA, status: 'pending', tenant: harness.tenantA.id })
      const update = (data: Record<string, unknown>) =>
        harness.payload.update({ collection: JOBS_SLUG, data, id, ...as(users.editorA) })

      await update({ status: 'published' })
      const published = await stored(id)
      const publishedAt = Date.parse(published.publishedAt as string)
      // This tenant has no timezone, so the listing ends at the end of a UTC day, 30 days on.
      expect(published.expiresAt).toBe(endOfLocalDayAfter(publishedAt, 30, 'UTC'))

      await update({ status: 'expired' })
      expect(Date.parse((await stored(id)).expiresAt as string)).toBeLessThanOrEqual(Date.now())

      await new Promise((resolve) => setTimeout(resolve, 5))
      await update({ status: 'published' })
      expect(Date.parse((await stored(id)).publishedAt as string)).toBeGreaterThan(publishedAt)

      await update({ status: 'cancelled' })
      await expect(update({ status: 'published' })).rejects.toThrow(/invalid: status/)
    })

    it('can’t work on another tenant’s jobs, and can delete their own', async () => {
      await expect(
        harness.payload.update({ collection: JOBS_SLUG, data: { title: 'x' }, id: ids.publishedB, ...as(users.editorA) }),
      ).rejects.toThrow()
      const id = await job({ organisation: ids.orgA, tenant: harness.tenantA.id })
      await harness.payload.delete({ collection: JOBS_SLUG, id, ...as(users.editorA) })
    })
  })

  describe('data rules', () => {
    it('keeps every relation inside the job’s tenant', async () => {
      await expect(
        job({ categories: [ids.healthB], organisation: ids.orgA, tenant: harness.tenantA.id }),
      ).rejects.toThrow()
      await expect(job({ organisation: ids.orgB, tenant: harness.tenantA.id })).rejects.toThrow()
    })

    it('only links a plan that allows the job’s type', async () => {
      await expect(
        job({ jobType: ids.fullTimeA, organisation: ids.orgA, plan: ids.volunteerA, tenant: harness.tenantA.id }),
      ).rejects.toThrow(/invalid: plan/)
      const id = await job({
        categories: [ids.healthA],
        jobType: ids.voluntaryA,
        organisation: ids.orgA,
        plan: ids.volunteerA,
        tenant: harness.tenantA.id,
      })
      expect((await stored(id)).plan).toBe(ids.volunteerA)
    })

    it('makes unique slugs from titles, and refuses an explicit duplicate in the same tenant', async () => {
      const first = await job({ organisation: ids.orgA, tenant: harness.tenantA.id, title: 'Nurse' })
      const second = await job({ organisation: ids.orgA, tenant: harness.tenantA.id, title: 'Nurse' })
      const otherTenant = await job({ organisation: ids.orgB, tenant: harness.tenantB.id, title: 'Nurse' })

      expect([(await stored(first)).slug, (await stored(second)).slug, (await stored(otherTenant)).slug]).toEqual([
        'nurse',
        'nurse-2',
        'nurse',
      ])
      await expect(job({ organisation: ids.orgA, slug: 'nurse', tenant: harness.tenantA.id })).rejects.toThrow()
    })

    it('keeps views unless the view counter writes them', async () => {
      await harness.payload.update({ collection: JOBS_SLUG, data: { views: 50 }, id: ids.publishedA, overrideAccess: true })
      expect((await stored(ids.publishedA)).views).toBe(0)
      await harness.payload.update({
        collection: JOBS_SLUG,
        context: { jobViews: true },
        data: { views: 7 },
        id: ids.publishedA,
        overrideAccess: true,
      })
      expect((await stored(ids.publishedA)).views).toBe(7)
    })
  })

  it('runs the placement expiry task against real jobs', async () => {
    const id = await job({
      organisation: ids.orgA,
      placements: [
        { expiresAt: at(-1), placement: 'featured-in-listings', startsAt: at(-10) },
        { expiresAt: at(5), placement: 'featured-in-category', startsAt: at(-1) },
      ],
      tenant: harness.tenantA.id,
    })

    const run = expireJobPlacementsTask().handler as (args: unknown) => Promise<{ output: Record<string, number> }>
    const { output } = await run({ req: { payload: harness.payload } })

    expect(output.jobsUpdated).toBeGreaterThanOrEqual(1)
    expect(((await stored(id)).placements as { placement: string }[]).map((row) => row.placement)).toEqual([
      'featured-in-category',
    ])
  })
})

const tabsOf = (documentsSlug: null | string) => {
  const jobs = jobsCollection({ documentsSlug, tenantScoped: true })
  const tabs = jobs.fields.find((field) => field.type === 'tabs')

  return tabs && tabs.type === 'tabs' ? tabs.tabs : []
}

const tabFieldNames = (documentsSlug: null | string) =>
  tabsOf(documentsSlug).flatMap((tab) =>
    tab.fields.flatMap((field) =>
      field.type === 'row'
        ? field.fields.map((inner) => ('name' in inner ? inner.name : null))
        : ['name' in field ? field.name : null],
    ),
  )

describe('job edit view tabs @S-117', () => {
  it('groups the editable fields into Details, Location, Apply, Files and SEO', () => {
    expect(tabsOf('documents').map((tab) => tab.label)).toEqual([
      'Details',
      'Location',
      'Apply',
      'Files',
      'SEO',
    ])
  })

  it('leaves the Files tab out when the host has no documents collection', () => {
    // The SEO tab stays: it needs no upload, because a job's share image is generated (PJ-105).
    expect(tabsOf(null).map((tab) => tab.label)).toEqual(['Details', 'Location', 'Apply', 'SEO'])
  })

  it('gives the job the same SEO overrides a page has, in one group @S-349', () => {
    const seo = tabsOf('documents')
      .flatMap((tab) => tab.fields)
      .find((field) => 'name' in field && field.name === 'seo')

    expect(seo).toMatchObject({ name: 'seo', type: 'group' })
    expect(
      ((seo as { fields: { name?: string }[] }).fields ?? []).map((field) => field.name),
    ).toEqual(['title', 'description', 'noIndex'])
  })

  it('keeps every field it had before the tabs, including the sidebar ones', () => {
    const jobs = jobsCollection({ documentsSlug: 'documents', tenantScoped: true })
    const topLevel = jobs.fields.flatMap((field) => ('name' in field && field.name ? [field.name] : []))

    expect(tabFieldNames('documents')).toEqual(
      expect.arrayContaining([
        'description',
        'jobType',
        'categories',
        'salaryBand',
        'displayedSalary',
        'companyName',
        'companyUrl',
        'location',
        'locationDetails',
        'howToApply',
        'applyOnline',
        'applicationsRecipient',
        'jobDescriptionPdf',
      ]),
    )
    // The fields that stay outside the tabs are the ones that always were: identity and sidebar.
    expect(topLevel).toEqual(
      expect.arrayContaining(['title', 'slug', 'organisation', 'status', 'plan', 'placements', 'views']),
    )
  })
})
