import type { Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { organisationsCollection } from './collections/organisations'
import { planCollection, withPlanRestrictionGuards } from './plans'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness } from './test'
import {
  APPLICATION_FILES_SLUG,
  APPLICATIONS_SLUG,
  applicationFilesCollection,
  applicationsCollection,
} from './collections/applications'
import {
  addMonths,
  applicationRetentionMonths,
  closedJobsWhere,
  DEFAULT_APPLICATION_RETENTION_MONTHS,
  DELETE_APPLICATIONS_TASK,
  deleteApplicationData,
  deleteExpiredApplicationsTask,
  isApplicationRetentionDue,
  jobClosedAt,
  retentionCutoff,
  tenantRetentionField,
  withApplicationDataAction,
} from './retention'

const NOW = new Date('2026-11-23T03:30:00.000Z')

describe('retention periods', () => {
  it('defaults to the 12 months the old site kept applications for @S-300', () => {
    expect(DEFAULT_APPLICATION_RETENTION_MONTHS).toBe(12)
    expect(applicationRetentionMonths(null)).toBe(12)
    expect(applicationRetentionMonths({})).toBe(12)
    expect(applicationRetentionMonths({ retention: { applicationsMonths: null } })).toBe(12)
    expect(applicationRetentionMonths({ retention: { applicationsMonths: 0 } })).toBe(12)
    expect(applicationRetentionMonths({ retention: { applicationsMonths: 1.5 } })).toBe(12)
  })

  it('uses the tenant’s own value, so a tenant can keep data for longer or shorter @S-300', () => {
    expect(applicationRetentionMonths({ retention: { applicationsMonths: 3 } })).toBe(3)
    expect(applicationRetentionMonths({ retention: { applicationsMonths: 24 } })).toBe(24)
  })

  it('counts calendar months, never short of the period, and clamps to a month’s last day @S-300', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe('2026-02-28T00:00:00.000Z')
    expect(addMonths(new Date('2024-01-31T00:00:00.000Z'), 1).toISOString()).toBe('2024-02-29T00:00:00.000Z')
    expect(addMonths(new Date('2026-03-31T12:00:00.000Z'), -1).toISOString()).toBe('2026-02-28T12:00:00.000Z')
    expect(addMonths(new Date('2026-11-23T03:30:00.000Z'), 12).toISOString()).toBe('2027-11-23T03:30:00.000Z')
    expect(retentionCutoff(12, NOW).toISOString()).toBe('2025-11-23T03:30:00.000Z')
  })
})

describe('job close dates', () => {
  it('starts the clock when an expired job ended, not when its row was last touched @S-301', () => {
    expect(
      jobClosedAt({
        expiresAt: '2025-01-01T00:00:00.000Z',
        status: 'expired',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })?.toISOString(),
    ).toBe('2025-01-01T00:00:00.000Z')
  })

  it('falls back to the last change for an expired job with no expiry, and to it for a cancelled one', () => {
    expect(jobClosedAt({ expiresAt: null, status: 'expired', updatedAt: '2025-02-02T00:00:00.000Z' })?.toISOString()).toBe(
      '2025-02-02T00:00:00.000Z',
    )
    expect(jobClosedAt({ status: 'cancelled', updatedAt: '2025-03-03T00:00:00.000Z' })?.toISOString()).toBe(
      '2025-03-03T00:00:00.000Z',
    )
  })

  it('does not start the clock for a live, draft or pending job', () => {
    expect(jobClosedAt({ status: 'published', expiresAt: '2025-01-01T00:00:00.000Z' })).toBeNull()
    expect(jobClosedAt({ status: 'draft' })).toBeNull()
    expect(jobClosedAt({ status: 'pending' })).toBeNull()
    expect(jobClosedAt(null)).toBeNull()
    expect(jobClosedAt({ status: 'expired', updatedAt: 'not a date' })).toBeNull()
  })

  it('is due exactly at the cutoff, and not a millisecond before @S-301', () => {
    const job = { expiresAt: '2025-11-23T03:30:00.000Z', status: 'expired' }
    expect(isApplicationRetentionDue(job, 12, NOW)).toBe(true)
    expect(isApplicationRetentionDue({ ...job, expiresAt: '2025-11-23T03:30:00.001Z' }, 12, NOW)).toBe(false)
    // A tenant that keeps applications longer holds the same job back.
    expect(isApplicationRetentionDue(job, 24, NOW)).toBe(false)
  })

  it('builds a query that names only ended jobs and never another tenant’s @S-302', () => {
    const where = closedJobsWhere({ cutoff: retentionCutoff(12, NOW), tenantID: 7 })
    const json = JSON.stringify(where)

    expect(json).toContain('"equals":"expired"')
    expect(json).toContain('"equals":"cancelled"')
    expect(json).toContain('"less_than_equal":"2025-11-23T03:30:00.000Z"')
    expect(json).toContain('{"tenant":{"equals":7}}')
    // Live jobs are never named.
    expect(json).not.toContain('published')
  })
})

const tenantFields: Field[] = [{ name: 'currency', type: 'text' }, tenantRetentionField()]

describe('application retention job in Postgres @S-300', () => {
  let harness: TestHarness
  const ids: Record<string, number> = {}

  const create = async (collection: string, data: Record<string, unknown>) =>
    ((await harness.payload.create({ collection, data, overrideAccess: true } as never)) as { id: number }).id

  const file = async (organisation: number, tenant: number): Promise<number> =>
    Number(
      (
        await (harness.payload as never as { db: { create: (args: unknown) => Promise<{ id: unknown }> } }).db.create({
          collection: APPLICATION_FILES_SLUG,
          data: {
            filename: `cv-${Math.random().toString(36).slice(2, 10)}.pdf`,
            filesize: 10,
            mimeType: 'application/pdf',
            organisation,
            tenant,
          },
        })
      ).id,
    )

  const apply = (job: number, cv: number, name = 'Someone') =>
    create(APPLICATIONS_SLUG, {
      consentAt: new Date().toISOString(),
      cv,
      email: 'someone@example.invalid',
      job,
      name,
    })

  /**
   * A job that closed at `closedAt`. Publishing stamps `expiresAt` from the plan, so the close
   * date is written the way an early close is: expire it, then set the date it ended.
   */
  const closedJob = async ({
    closedAt,
    organisation = ids.orgA,
    tenant,
    title,
  }: {
    closedAt: string
    organisation?: number
    tenant: number
    title: string
  }): Promise<number> => {
    const job = await create('jobs', { organisation, status: 'published', tenant, title })
    await harness.payload.update({
      collection: 'jobs',
      data: { status: 'expired' } as never,
      id: job,
      overrideAccess: true,
    })
    await harness.payload.update({
      collection: 'jobs',
      data: { expiresAt: closedAt } as never,
      id: job,
      overrideAccess: true,
    })

    return job
  }

  const runTask = async () => {
    const task = deleteExpiredApplicationsTask({
      clock: () => NOW,
      jobsSlug: 'jobs',
      tenancy: 'multi',
      tenantsSlug: 'tenants',
    })
    const handler = task.handler as unknown as (args: unknown) => Promise<{ output: Record<string, number> }>
    const { payload } = harness
    const req = { payload, user: null } as never

    return (await handler({ req })).output
  }

  const count = async (collection: string, where: Record<string, unknown>) =>
    (await harness.payload.count({ collection, overrideAccess: true, where } as never)).totalDocs

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [
        organisationsCollection({ mediaSlug: null, tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        planCollection(),
        addOnCollection(),
        jobsCollection({ tenantScoped: true }),
        applicationFilesCollection({ tenantScoped: true }),
        applicationsCollection({ tenantScoped: true }),
      ],
      // Tenant A keeps the default year; tenant B keeps applications for two months only.
      tenantData: (which: 'A' | 'B') => ({
        currency: 'VUV',
        retention: { applicationsMonths: which === 'A' ? 12 : 2 },
      }),
      tenantFields,
    })
    const { tenantA, tenantB } = harness

    ids.orgA = await create('organisations', { name: 'Org A', slug: 'org-a', tenant: tenantA.id })
    ids.orgB = await create('organisations', { name: 'Org B', slug: 'org-b', tenant: tenantB.id })

    ids.oldA = await closedJob({ closedAt: '2025-01-01T00:00:00.000Z', tenant: tenantA.id, title: 'Old A' })
    ids.recentA = await closedJob({ closedAt: '2026-11-01T00:00:00.000Z', tenant: tenantA.id, title: 'Recent A' })
    ids.liveA = await create('jobs', {
      organisation: ids.orgA,
      status: 'published',
      tenant: tenantA.id,
      title: 'Live A',
    })
    // Two months is up for tenant B, so a job that closed in September is already past it.
    ids.oldB = await closedJob({
      closedAt: '2026-09-01T00:00:00.000Z',
      organisation: ids.orgB,
      tenant: tenantB.id,
      title: 'Old B',
    })
    // The same close date in tenant A is well inside its year.
    ids.septA = await closedJob({ closedAt: '2026-09-01T00:00:00.000Z', tenant: tenantA.id, title: 'Sept A' })

    ids.cvOldA = await file(ids.orgA, tenantA.id)
    ids.cvRecentA = await file(ids.orgA, tenantA.id)
    ids.cvLiveA = await file(ids.orgA, tenantA.id)
    ids.cvOldB = await file(ids.orgB, tenantB.id)
    ids.cvSeptA = await file(ids.orgA, tenantA.id)

    ids.appSeptA = await apply(ids.septA, ids.cvSeptA)
    ids.appOldA = await apply(ids.oldA, ids.cvOldA)
    ids.appRecentA = await apply(ids.recentA, ids.cvRecentA)
    ids.appLiveA = await apply(ids.liveA, ids.cvLiveA)
    ids.appOldB = await apply(ids.oldB, ids.cvOldB)
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('deletes only the applications of jobs closed past the tenant’s retention @S-300', async () => {
    const output = await runTask()

    expect(output).toEqual({ applicationsDeleted: 2, filesDeleted: 2 })
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appOldA } })).toBe(0)
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appOldB } })).toBe(0)
    // The live job's application and the recent one stay.
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appLiveA } })).toBe(1)
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appRecentA } })).toBe(1)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvOldA } })).toBe(0)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvOldB } })).toBe(0)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvLiveA } })).toBe(1)
  })

  it('keeps tenant A’s application when tenant B’s job closed on the same day @S-302', async () => {
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appSeptA } })).toBe(1)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvSeptA } })).toBe(1)
    // Tenant B's identical close date was past its two months.
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appOldB } })).toBe(0)
  })

  it('is idempotent: a second run deletes nothing @S-300', async () => {
    expect(await runTask()).toEqual({ applicationsDeleted: 0, filesDeleted: 0 })
  })

  it('deletes one applicant’s data on request, and only that application’s files @S-303', async () => {
    const req = { payload: harness.payload, user: null } as never
    const application = await harness.payload.findByID({
      collection: APPLICATIONS_SLUG,
      depth: 0,
      id: ids.appRecentA,
      overrideAccess: true,
    })

    expect(await deleteApplicationData({ application: application as never, req })).toEqual({ filesDeleted: 1 })
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appRecentA } })).toBe(0)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvRecentA } })).toBe(0)
    // The live application and its CV are untouched.
    expect(await count(APPLICATIONS_SLUG, { id: { equals: ids.appLiveA } })).toBe(1)
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvLiveA } })).toBe(1)
  })

  it('leaves a CV another application still points at @S-303', async () => {
    const shared = await apply(ids.liveA, ids.cvLiveA, 'Second')
    const req = { payload: harness.payload, user: null } as never
    const application = await harness.payload.findByID({
      collection: APPLICATIONS_SLUG,
      depth: 0,
      id: shared,
      overrideAccess: true,
    })

    expect(await deleteApplicationData({ application: application as never, req })).toEqual({ filesDeleted: 0 })
    expect(await count(APPLICATION_FILES_SLUG, { id: { equals: ids.cvLiveA } })).toBe(1)
  })
})

describe('application data action wiring @S-303', () => {
  it('adds the endpoint and the button to the applications collection', () => {
    const collection = withApplicationDataAction(applicationsCollection({ tenantScoped: true }))
    const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []

    expect(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toContain('post /:id/delete-data')
    expect(JSON.stringify(collection.admin?.components?.edit?.beforeDocumentControls)).toContain(
      '@mission-control/payload-jobs/rsc#DeleteApplicantData',
    )
  })

  it('keeps the components the host already had, and answers a bad id without deleting', async () => {
    const base = {
      ...applicationsCollection({ tenantScoped: true }),
      admin: { components: { edit: { beforeDocumentControls: [{ path: '@host/before' }] } } },
    }
    const collection = withApplicationDataAction(base)
    const before = collection.admin?.components?.edit?.beforeDocumentControls as { path: string }[]

    expect(before.map((component) => component.path)).toEqual([
      '@host/before',
      '@mission-control/payload-jobs/rsc#DeleteApplicantData',
    ])

    const endpoints = Array.isArray(collection.endpoints) ? collection.endpoints : []
    const endpoint = endpoints[0]
    const response = (await endpoint.handler({ routeParams: {}, payload: {} } as never)) as Response
    expect(response.status).toBe(400)
  })
})

describe('task registration @S-300', () => {
  it('is a daily task with a stable slug', () => {
    const task = deleteExpiredApplicationsTask()

    expect(task.slug).toBe(DELETE_APPLICATIONS_TASK)
    expect(task.schedule).toEqual([{ cron: '0 30 3 * * *', queue: 'hourly' }])
  })
})
