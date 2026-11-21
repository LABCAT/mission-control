import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, jobTables, locationDocs } from '../test/fixtures'
import { buildJobLocationMatcher } from './job-locations'
import {
  canonicalTerm,
  closeDateOf,
  importableStatus,
  jobsImporters,
  parseLegacyDate,
  placementsOf,
} from './jobs'
import { LEGACY_TAXONOMY_KEYS, readTaxonomyTerms, taxonomyImporters } from './taxonomies'
import { createPlanProvider, usersImporters } from './users'

const NOW = new Date('2026-11-20T00:00:00Z')
const TENANT = 1

const readerFor = () => new MysqlReader({ connect: async () => createFixtureConnection(jobTables), pageSize: 4 })

const importers = () => {
  const planProvider = createPlanProvider({ now: () => NOW })
  const users = usersImporters({ now: () => NOW, planProvider })
  const jobs = jobsImporters({ now: () => NOW, planProvider })
  return [...taxonomyImporters(), users.organisations, users.users, jobs.jobOrganisations, jobs.jobs]
}

const seed = () => ({
  locations: locationDocs.map((doc) => ({ ...doc, tenant: TENANT })),
})

const run = async (dryRun: boolean, payload = createFakePayload(seed())) => {
  const summary = await runImport({ dryRun, importers: importers(), payload: payload.payload, reader: readerFor(), tenant: TENANT })
  return { ...payload, summary }
}

const jobBy = (store: Record<string, any[]>, legacyId: number) => store.jobs!.find((job) => job.legacyId === legacyId)

describe('legacy status, dates and close date @S-155', () => {
  it('imports only published and expired jobs', () => {
    expect(importableStatus('publish')).toBe('published')
    expect(importableStatus('expired')).toBe('expired')
    for (const status of ['draft', 'pending', 'trash', 'auto-draft', 'private']) expect(importableStatus(status)).toBeNull()
  })

  it('reads WordPress dates, rejecting the zero date', () => {
    expect(parseLegacyDate('2026-11-01 09:00:00')?.toISOString()).toBe('2026-11-01T09:00:00.000Z')
    expect(parseLegacyDate('2026-11-01 09:00:00', 660)?.toISOString()).toBe('2026-10-31T22:00:00.000Z')
    expect(parseLegacyDate('0000-00-00 00:00:00')).toBeNull()
    expect(parseLegacyDate('1767225600')?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
    expect(parseLegacyDate('garbage')).toBeNull()
  })

  const base = {
    defaultDays: 30,
    expireDays: undefined,
    jobDuration: undefined,
    modifiedAt: null,
    now: NOW,
    publishedAt: new Date('2026-10-01T00:00:00Z'),
    reason: undefined,
    status: 'published' as const,
  }

  it('prefers the employer’s close date days, then the plan duration, then the default', () => {
    const days = (extra: Partial<Parameters<typeof closeDateOf>[0]>) =>
      (closeDateOf({ ...base, ...extra }).getTime() - base.publishedAt.getTime()) / 86_400_000
    expect(days({ expireDays: '14', jobDuration: '30' })).toBe(14)
    expect(days({ expireDays: '', jobDuration: '30' })).toBe(30)
    expect(days({ expireDays: '0', jobDuration: 'x' })).toBe(30)
    expect(days({ defaultDays: 45 })).toBe(45)
  })

  it('never gives an expired job a future close date', () => {
    const planned = { ...base, status: 'expired' as const, reason: 'job_has_expired_cron' }
    // Planned close is after "now", and there is no usable modified date: it closed now at the latest.
    expect(closeDateOf({ ...planned, now: new Date('2026-10-10T00:00:00Z') }).toISOString()).toBe('2026-10-10T00:00:00.000Z')
    expect(
      closeDateOf({ ...planned, modifiedAt: new Date('2026-09-01T00:00:00Z'), now: new Date('2026-10-10T00:00:00Z') }).toISOString(),
    ).toBe('2026-10-10T00:00:00.000Z')
  })

  it('closes an expired job that was ended early when it was last modified', () => {
    const modifiedAt = new Date('2026-10-05T00:00:00Z')
    const ended = closeDateOf({ ...base, modifiedAt, reason: 'user_ended', status: 'expired' })
    expect(ended).toEqual(modifiedAt)
    // Expired by the cron: keeps the planned date, so the 12-month 410 rule counts from it.
    const cron = closeDateOf({ ...base, modifiedAt, reason: 'job_has_expired_cron', status: 'expired', now: new Date('2027-01-01') })
    expect(cron.toISOString()).toBe('2026-10-31T00:00:00.000Z')
  })
})

describe('salary and job type clean-up @S-155', () => {
  const terms = async () => {
    const reader = readerFor()
    return {
      types: await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS['job-types']),
      salary: await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS['salary-bands']),
    }
  }

  it('folds Independant into Independent', async () => {
    const { types } = await terms()
    const independant = types.find((t) => t.slug === 'independant')!
    expect(canonicalTerm('job-types', independant, types)?.slug).toBe('independent')
  })

  it('drops the broken salary terms and folds the 1-2M bands', async () => {
    const { salary } = await terms()
    expect(canonicalTerm('salary-bands', salary.find((t) => t.slug === '000')!, salary)).toBeNull()
    expect(canonicalTerm('salary-bands', salary.find((t) => t.slug === '1000000-1500000')!, salary)?.slug).toBe('1000000-2000000')
    expect(canonicalTerm('salary-bands', salary.find((t) => t.slug === '0-100000')!, salary)?.slug).toBe('0-100000')
  })

  it('keeps a term whose fold target is missing instead of losing it', async () => {
    const { types } = await terms()
    const alone = types.filter((t) => t.slug !== 'independent')
    expect(canonicalTerm('job-types', alone.find((t) => t.slug === 'independant')!, alone)?.slug).toBe('independant')
  })
})

describe('featured placements @S-155', () => {
  const args = {
    closesAt: new Date('2026-12-01T00:00:00Z'),
    featuredInCategory: false,
    now: NOW,
    offsetMinutes: 0,
    publishedAt: new Date('2026-11-01T00:00:00Z'),
  }

  it('features a flagged job from its start date for the paid duration', () => {
    const { placements } = placementsOf({
      ...args,
      meta: { '_jr_featured-listings': '1', '_jr_featured-listings_duration': '30', '_jr_featured-listings_start_date': '2026-11-10' },
    })
    expect(placements).toEqual([
      { expiresAt: '2026-12-10T00:00:00.000Z', placement: 'featured-in-listings', startsAt: '2026-11-10T00:00:00.000Z' },
    ])
  })

  it('features a flagged job without a duration until it closes', () => {
    expect(placementsOf({ ...args, meta: { '_jr_featured-listings': '1' } }).placements[0]).toMatchObject({
      expiresAt: '2026-12-01T00:00:00.000Z',
      startsAt: '2026-11-01T00:00:00.000Z',
    })
  })

  it('skips ended placements, and featured-in-category unless the setting is on', () => {
    const meta = { '_jr_featured-cat': '1', '_jr_featured-listings': '1', '_jr_featured-listings_duration': '5' }
    const off = placementsOf({ ...args, meta })
    expect(off).toMatchObject({ ended: 1, placements: [], skippedCategory: 1 })
    const on = placementsOf({ ...args, featuredInCategory: true, meta })
    expect(on.placements.map((p) => p.placement)).toEqual(['featured-in-category'])
    expect(placementsOf({ ...args, meta: { '_jr_featured-listings': '' } }).placements).toEqual([])
  })
})

describe('location chips @S-155', () => {
  const match = buildJobLocationMatcher(locationDocs as any)
  const names = (label: string) => match(label).locations.map((l) => l.name).toSorted()

  it('reads the picker pair exactly and keeps no details', () => {
    expect(match('Port Vila, Efate')).toMatchObject({ exact: true })
    expect(names('Port Vila, Efate')).toEqual(['Port Vila'])
    expect(names('Efate,Port Vila')).toEqual(['Port Vila'])
    expect(names('Anywhere/Work From Home, Other')).toEqual(['Anywhere/Work From Home'])
  })

  it('splits several places on and, &, ; and commas, and keeps the original as details', () => {
    expect(names('Efate, Santo and Tanna')).toEqual(['Efate', 'Espiritu Santo', 'Tanna'])
    expect(names('Port Vila & Luganville')).toEqual(['Luganville', 'Port Vila'])
    expect(names('Luganville - SANTO')).toEqual(['Luganville'])
    expect(match('Efate, Santo and Tanna').exact).toBe(false)
  })

  it('fixes small typos and expands provinces to the islands that exist', () => {
    expect(names('Luganvile')).toEqual(['Luganville'])
    expect(names('Tafea')).toEqual(['Tanna'])
    expect(match('Atlantis')).toMatchObject({ locations: [], unmatched: ['Atlantis'] })
  })
})

describe('the jobs importer @S-155', () => {
  it('fails a job whose category is missing, like a missing job type', async () => {
    const payload = createFakePayload(seed())
    const planProvider = createPlanProvider({ now: () => NOW })
    const { jobOrganisations, jobs } = jobsImporters({ now: () => NOW, planProvider })
    const only = [
      { ...jobOrganisations, dependsOn: [] },
      { ...jobs, dependsOn: ['job-organisations'] },
    ]
    // No taxonomies imported: the job type is checked first, so drop it to reach the category.
    const summary = await runImport({ importers: only, payload: payload.payload, reader: readerFor(), tenant: TENANT })
    expect(summary.importers.jobs!.failed).toBeGreaterThan(0)
    expect(summary.errors.some((e) => /was not found/.test(e.message))).toBe(true)
  })

  it('imports published and expired jobs and counts what it leaves out', async () => {
    const { store, summary } = await run(false)

    expect(summary.errors).toEqual([])
    expect(summary.importers.jobs).toMatchObject({ created: 5, failed: 0, skipped: 5 })
    // 901 and 903 are the PJ-62 fixture's job posts, which have no title.
    expect(summary.importers.jobs!.skipReasons).toEqual({ 'no-organisation': 1, 'no-title': 2, 'status-draft': 1, 'status-trash': 1 })
    expect(store.jobs).toHaveLength(5)
    expect(jobBy(store, 1003)).toBeUndefined()
    expect(jobBy(store, 1004)).toBeUndefined()
  })

  it('maps fields, organisation, taxonomies, placements and views of a published job', async () => {
    const { store } = await run(false)
    const job = jobBy(store, 1001)!
    const org = store.organisations!.find((o) => o.legacyId === 2)!

    expect(job).toMatchObject({
      applyOnline: false,
      applicationsRecipient: 'jobs@example.com',
      companyUrl: 'https://example-resort.test',
      displayedSalary: 'VT 100,000 – 120,000 a month',
      howToApply: 'Email us now\nor call',
      organisation: org.id,
      publishedAt: '2026-10-31T22:00:00.000Z',
      slug: 'front-desk-clerk',
      status: 'published',
      tenant: TENANT,
      title: 'Front Desk Clerk',
      views: 120,
    })
    expect(job.expiresAt).toBe('2026-11-14T22:00:00.000Z') // 14 days: the employer's choice
    expect(job.companyName).toBe('Example Resort Ltd') // set explicitly: rawCreate skips the hook that defaults it
    expect(job.jobType).toBe(store['job-types']!.find((t) => t.legacyId === 21)!.id)
    expect(job.categories).toHaveLength(2)
    expect(job.salaryBand).toBe(store['salary-bands']!.find((t) => t.legacyId === 41)!.id)
    expect(job.location).toEqual([2])
    expect(job.locationDetails).toBeUndefined()
    // Featured for its paid 30 days; featured-in-category is not seeded.
    expect(job.placements).toEqual([
      { expiresAt: '2026-12-01T00:00:00.000Z', id: expect.any(String), placement: 'featured-in-listings', startsAt: '2026-11-01T00:00:00.000Z' },
    ])
    expect(job.user_IP).toBeUndefined()
    expect(JSON.stringify(job)).not.toContain('203.0.113.9')
    expect(job.description.root.children[0].type).toBe('paragraph')
  })

  it('creates an organisation for a company with none, and links the expired job to it', async () => {
    const { store } = await run(false)
    const client = store.organisations!.find((o) => o.legacyId === -1002)!

    expect(client).toMatchObject({ approved: true, name: 'Client Agency Co', pageEnabled: false, slug: 'client-agency-co', tenant: TENANT })
    const expired = jobBy(store, 1002)!
    expect(expired).toMatchObject({ organisation: client.id, status: 'expired', slug: 'boat-skipper', views: 7 })
    // Ended early (user_ended): closed when it was last modified, so the dates stay usable for the 12-month rule.
    expect(expired.expiresAt).toBe('2025-01-19T22:00:00.000Z')
    expect(expired.publishedAt).toBe('2025-01-09T22:00:00.000Z')
    expect(expired.companyName).toBe('Client Agency Co')
  })

  it('falls back to the author’s organisation, and keeps unmatched text as details', async () => {
    const { store } = await run(false)
    const job = jobBy(store, 1005)!
    expect(job.organisation).toBe(store.organisations!.find((o) => o.legacyId === 6)!.id)
    expect(job.location).toEqual([])
    expect(job.locationDetails).toBe('Nowhere, Atlantis')
  })

  it('applies salary and job type clean-up when linking', async () => {
    const { store } = await run(false)
    const job = jobBy(store, 1008)!
    // `Independant` folds to `Independent`; the broken '000' is dropped; 1-1.5M folds into 1-2M.
    expect(job.jobType).toBe(store['job-types']!.find((t) => t.legacyId === 27)!.id)
    expect(job.salaryBand).toBe(store['salary-bands']!.find((t) => t.legacyId === 44)!.id)
    expect(job.location).toEqual([2])
  })

  it('suffixes a slug that equals a category slug, and strips hostile markup', async () => {
    const { store } = await run(false)
    const job = jobBy(store, 1007)!
    expect(job.slug).toBe('hospitality-tourism-2')
    const text = JSON.stringify(job.description)
    expect(text).not.toMatch(/alert|script|javascript|onerror|<img/i)
    expect(text).toContain('Hi')
    expect(job.location).toHaveLength(3)
    expect(job.locationDetails).toBe('Efate, Santo and Tanna')
  })

  it('is idempotent and never lowers the view counter on a re-run', async () => {
    const payload = createFakePayload(seed())
    await run(false, payload)
    const job = jobBy(payload.store, 1001)!
    job.views = 500 // visits counted by the new site since the first import

    const again = await run(false, payload)
    expect(again.summary.errors).toEqual([])
    expect(again.summary.importers.jobs).toMatchObject({ created: 0, updated: 5 })
    expect(again.summary.importers['job-organisations']).toMatchObject({ created: 0, updated: 1 })
    expect(payload.store.jobs).toHaveLength(5)
    expect(jobBy(payload.store, 1001)!.views).toBe(500)
  })

  it('dry run writes nothing and reports the same counts as a real run', async () => {
    const fresh = createFakePayload(seed())
    const dry = await run(true, fresh)
    expect(fresh.writes).toEqual([])
    const real = await run(false)

    expect(dry.summary.importers.jobs).toMatchObject({ created: 5, failed: 0, skipped: 5 })
    const keys = (r: any) => JSON.stringify(r.importers.jobs.report)
    expect(keys(dry.summary)).toBe(keys(real.summary))
    expect(dry.summary.importers.jobs!.report).toMatchObject({
      'imported published': 4,
      'imported expired': 1,
      'job type: Full-Time': 3,
      'legacy jobs read': 10,
    })
  })

  it('scopes everything to the tenant it runs for', async () => {
    const payload = createFakePayload({ ...seed(), jobs: [{ id: 9, legacyId: 1001, tenant: 2, title: 'Other tenant' }] })
    await run(false, payload)
    expect(payload.store.jobs!.find((j) => j.id === 9)).toMatchObject({ title: 'Other tenant', tenant: 2 })
    expect(payload.store.jobs!.filter((j) => j.tenant === TENANT)).toHaveLength(5)
  })
})
