import {
  addOnCollection,
  jobsCollection,
  locationsCollection,
  orderCollection,
  organisationsCollection,
  planCollection,
  taxonomyCollections,
  withPlanRestrictionGuards,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFixtureConnection, jobTables, locationDocs } from '../test/fixtures'
import { jobsImporters } from './jobs'
import { taxonomyImporters } from './taxonomies'
import { createPlanProvider } from './users'

/** The importer against a real Payload: the state machine, the views guard and Lexical validation. */
describe('jobs import against Payload @S-155', () => {
  let harness: TestHarness
  const NOW = new Date('2026-11-20T00:00:00Z')
  const system = { overrideAccess: true } as const

  beforeAll(async () => {
    // Localization on, as in the CMS: the adapter writes localized fields differently.
    harness = await bootTestPayload({
      localization: { defaultLocale: 'en', locales: ['en'] },
      collections: [
        orderCollection({ couponsEnabled: false }),
        jobsCollection({ withOrder: true }),
        organisationsCollection({ mediaSlug: null }),
        planCollection(),
        addOnCollection(),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
      ],
    })
  }, 120_000)

  afterAll(async () => {
    await harness?.destroy()
  })

  const doImport = async (dryRun: boolean) => {
    const planProvider = createPlanProvider({ now: () => NOW })
    const { jobOrganisations, jobs } = jobsImporters({ now: () => NOW, planProvider })
    const reader = new MysqlReader({ connect: async () => createFixtureConnection(jobTables), pageSize: 4 })
    return runImport({
      dryRun,
      importers: [...taxonomyImporters(), { ...jobOrganisations, dependsOn: [] }, { ...jobs, dependsOn: ['job-organisations', 'job-categories', 'job-types', 'salary-bands'] }],
      payload: harness.payload as never,
      reader,
      tenant: harness.tenantA.id,
    })
  }

  it('creates published and expired jobs through the real collection, and is idempotent', async () => {
    const { payload, tenantA } = harness
    // The organisations of the users import (PJ-62), and the tenant's locations.
    const orgs: Record<number, number> = {}
    for (const [legacyId, name] of [[2, 'Example Resort Ltd'], [6, 'Sample Charters']] as const) {
      orgs[legacyId] = (await payload.create({
        collection: 'organisations',
        data: { legacyId, name, slug: name.toLowerCase().replaceAll(' ', '-'), tenant: tenantA.id } as never,
        ...system,
      })).id as number
    }
    const locations = new Map<string, number>()
    for (const doc of locationDocs.filter((d) => !d.parent)) {
      locations.set(doc.slug, (await payload.create({ collection: 'locations', data: { name: doc.name, slug: doc.slug, tenant: tenantA.id } as never, ...system })).id as number)
    }
    for (const doc of locationDocs.filter((d) => d.parent)) {
      await payload.create({ collection: 'locations', data: { name: doc.name, parent: locations.get((doc.parent as { slug: string }).slug), slug: doc.slug, tenant: tenantA.id } as never, ...system })
    }

    const dry = await doImport(true)
    expect(dry.errors).toEqual([])

    const first = await doImport(false)
    expect(first.errors).toEqual([])
    expect(first.importers.jobs).toMatchObject({ created: 5, failed: 0 })

    const { docs } = await payload.find({ collection: 'jobs', depth: 0, limit: 50, pagination: false, where: { tenant: { equals: tenantA.id } }, ...system })
    expect(docs).toHaveLength(5)
    const expired = docs.find((job: any) => job.legacyId === 1002) as any
    expect(expired).toMatchObject({ slug: 'boat-skipper', status: 'expired', views: 7 })
    const published = docs.find((job: any) => job.legacyId === 1001) as any
    expect(published).toMatchObject({ organisation: orgs[2], status: 'published', views: 120 })
    expect(published.placements).toHaveLength(1)
    // Localized fields are written by the very first run, not healed by a second one.
    expect(published).toMatchObject({
      companyName: 'Example Resort Ltd',
      displayedSalary: 'VT 100,000 – 120,000 a month',
      howToApply: 'Email us now\nor call',
      title: 'Front Desk Clerk',
    })
    expect(JSON.stringify(published.description)).toContain('guests')
    expect(docs.every((job: any) => typeof job.title === 'string' && job.title.length > 0)).toBe(true)
    expect(docs.find((job: any) => job.legacyId === 1005)).toMatchObject({ locationDetails: 'Nowhere, Atlantis' })
    expect(JSON.stringify(docs.find((job: any) => job.legacyId === 1007)!.description)).toContain('Hi')

    // The views guard only lets the counter through, and the re-run must not duplicate anything.
    await payload.update({ collection: 'jobs', id: published.id, data: { views: 999 }, context: { jobViews: true }, ...system })
    const second = await doImport(false)
    expect(second.errors).toEqual([])
    expect(second.importers.jobs).toMatchObject({ created: 0, failed: 0, updated: 5 })
    const after = await payload.findByID({ collection: 'jobs', id: published.id, depth: 0, ...system })
    expect(after.views).toBe(999)
    const total = await payload.count({ collection: 'jobs', where: { tenant: { equals: tenantA.id } }, ...system })
    expect(total.totalDocs).toBe(5)
  }, 120_000)
})
