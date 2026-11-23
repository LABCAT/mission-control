import { describe, expect, it } from 'vitest'

import type { CmsClient } from '../cms/client'
import { liveJobsWhere } from '../jobs/listing'
import {
  countLiveJobs,
  initialsOf,
  loadOrganisationDirectory,
  ORGANISATION_DIRECTORY_LIMIT,
  parseDirectoryFilters,
  toDirectoryEntry,
} from './directory'
import { loadOrganisationProfile } from './profile'

const tenant = { currency: 'VUV', name: 'Vanuatu Wok', slug: 'vwok', timezone: 'Pacific/Efate' }
const NOW = new Date('2026-11-20T00:00:00.000Z')

type Call = { collection: string; options: Record<string, unknown>; via: string }

const fakeCms = ({
  jobs = [],
  organisations = [],
  bySlug = {},
}: {
  bySlug?: Record<string, unknown>
  jobs?: unknown[]
  organisations?: unknown[]
}) => {
  const calls: Call[] = []
  const cms = {
    find: async (collection: string, options: Record<string, unknown> = {}) => {
      calls.push({ collection, options, via: 'find' })
      const docs = collection === 'organisations' ? organisations : jobs
      return { docs, totalDocs: docs.length } as never
    },
    findAll: async (collection: string, options: Record<string, unknown> = {}) => {
      calls.push({ collection, options, via: 'findAll' })
      return (collection === 'jobs' ? jobs : organisations) as never
    },
    findBySlug: async (collection: string, slug: string, options: Record<string, unknown> = {}) => {
      calls.push({ collection, options: { ...options, slug }, via: 'findBySlug' })
      return (bySlug[slug] ?? null) as never
    },
  } as unknown as Pick<CmsClient, 'find' | 'findAll' | 'findBySlug'>
  return { calls, cms }
}

const org = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  ...extra,
})

describe('directory filters @S-223', () => {
  it('keeps only known type and size values', () => {
    expect(parseDirectoryFilters(new URLSearchParams('type=nfp&size=11-50'))).toEqual({
      size: '11-50',
      type: 'nfp',
    })
    expect(parseDirectoryFilters(new URLSearchParams('type=evil&size=huge'))).toEqual({})
    expect(parseDirectoryFilters(new URLSearchParams('type[$ne]=x'))).toEqual({})
    expect(parseDirectoryFilters(null)).toEqual({})
  })

  it('asks the CMS for the filtered organisations and nothing else', async () => {
    const { calls, cms } = fakeCms({})
    await loadOrganisationDirectory({ cms, filters: { size: '11-50', type: 'nfp' }, now: NOW, tenant })

    const query = calls.find((call) => call.collection === 'organisations')?.options
    expect(query?.where).toEqual({
      and: [{ type: { equals: 'nfp' } }, { size: { equals: '11-50' } }],
    })
    // No access rule of its own: the CMS only returns public organisations to a site key.
    expect(JSON.stringify(query)).not.toContain('approved')
    expect(query?.select).toMatchObject({ name: true, slug: true, logo: true })
    expect(query?.select).not.toHaveProperty('billingEmail')
    expect(query?.select).not.toHaveProperty('legacyId')
  })

  it('sends no where when nothing is filtered', async () => {
    const { calls, cms } = fakeCms({})
    await loadOrganisationDirectory({ cms, now: NOW, tenant })
    expect(calls.find((call) => call.collection === 'organisations')?.options).not.toHaveProperty('where')
  })
})

describe('directory entries @S-223', () => {
  it('counts live jobs per organisation, listing organisations with none too', async () => {
    const { calls, cms } = fakeCms({
      jobs: [{ organisation: 1 }, { organisation: { id: 1 } }, { organisation: 2 }, { organisation: null }],
      organisations: [org(1, 'Santo Bakery'), org(2, 'Efate Tours'), org(3, 'Quiet Charity')],
    })

    const { entries } = await loadOrganisationDirectory({ cms, now: NOW, tenant })

    expect(entries.map((entry) => [entry.name, entry.jobCount])).toEqual([
      ['Santo Bakery', 2],
      ['Efate Tours', 1],
      ['Quiet Charity', 0],
    ])
    // The count comes from the live-jobs rule, in one request for the whole page.
    expect(calls.filter((call) => call.collection === 'jobs')).toHaveLength(1)
    expect(calls.find((call) => call.collection === 'jobs')?.options.where).toEqual(liveJobsWhere(NOW))
  })

  it('links every entry to its own organisation page', () => {
    expect(toDirectoryEntry(org(1, 'Santo Bakery'), 0)?.url).toBe('/organisations/santo-bakery')
    expect(toDirectoryEntry({ id: 1, name: 'No Slug' }, 0)).toBeNull()
    expect(toDirectoryEntry({ id: 1, slug: 'no-name' }, 0)).toBeNull()
  })

  it('shows the logo with its size, or no logo so the initials stand in', () => {
    const withLogo = toDirectoryEntry(
      org(1, 'Santo Bakery', { logo: { height: 80, url: 'https://cdn/logo.png', width: 160 } }),
      0,
    )
    expect(withLogo?.logo).toEqual({ height: 80, url: 'https://cdn/logo.png', width: 160 })

    const unpopulated = toDirectoryEntry(org(2, 'Efate Tours', { logo: 7 }), 0)
    expect(unpopulated?.logo).toBeUndefined()
    expect(unpopulated?.initials).toBe('ET')
  })

  it('labels type and size from the tenant-neutral option lists', () => {
    const entry = toDirectoryEntry(org(1, 'Santo Bakery', { size: '11-50', type: 'nfp' }), 0)
    expect(entry).toMatchObject({ sizeLabel: '11–50 people', typeLabel: 'Not-for-profit' })
  })

  it('draws at most the guard’s worth of organisations and says it truncated', async () => {
    const many = Array.from({ length: ORGANISATION_DIRECTORY_LIMIT + 1 }, (_, i) => org(i + 1, `Org ${i + 1}`))
    const { cms } = fakeCms({ organisations: many })

    const result = await loadOrganisationDirectory({ cms, now: NOW, tenant })

    expect(result.entries).toHaveLength(ORGANISATION_DIRECTORY_LIMIT)
    expect(result.truncated).toBe(true)
  })

  it('makes initials from the first two words, ignoring punctuation', () => {
    expect(initialsOf('Vanuatu Brewing Co')).toBe('VB')
    expect(initialsOf('  “Wok” & Roll ')).toBe('WR')
    expect(initialsOf('santo')).toBe('S')
    expect(initialsOf('')).toBe('')
  })

  it('ignores job rows without an organisation when counting', () => {
    expect([...countLiveJobs([{}, { organisation: undefined }])]).toEqual([])
  })
})

describe('organisation page @S-224', () => {
  const santo = org(5, 'Santo Bakery', {
    about: 'Bread, daily.',
    location: { name: 'Luganville' },
    logo: { height: 64, url: 'https://cdn/s.png', width: 64 },
    website: 'https://santobakery.example',
  })
  const job = (id: number, organisation: unknown) => ({
    id,
    organisation,
    publishedAt: '2026-11-01T00:00:00.000Z',
    slug: `job-${id}`,
    title: `Job ${id}`,
  })

  it('loads the profile and only this organisation’s live jobs', async () => {
    const { calls, cms } = fakeCms({
      bySlug: { 'santo-bakery': santo },
      jobs: [job(1, { id: 5, name: 'Santo Bakery', slug: 'santo-bakery' })],
    })

    const result = await loadOrganisationProfile({ cms, now: NOW, slug: 'santo-bakery', tenant })

    expect(result.kind).toBe('found')
    if (result.kind !== 'found') return
    expect(result.profile).toMatchObject({
      about: 'Bread, daily.',
      location: 'Luganville',
      name: 'Santo Bakery',
      website: 'https://santobakery.example/',
    })
    expect(result.profile.jobs.map((entry) => entry.title)).toEqual(['Job 1'])

    // The jobs query is the live rule plus this organisation's id: a possible duplicate has its
    // own id, so its jobs cannot reach the official page until the two are merged.
    const jobsQuery = calls.find((call) => call.collection === 'jobs')?.options
    expect(jobsQuery?.where).toEqual({
      and: [...(liveJobsWhere(NOW).and ?? []), { organisation: { equals: 5 } }],
    })
  })

  it('is not found when the CMS does not return the organisation: private, unapproved, duplicate', async () => {
    const { calls, cms } = fakeCms({ bySlug: {} })

    expect(await loadOrganisationProfile({ cms, slug: 'private-co', tenant })).toEqual({ kind: 'not-found' })
    // And it never goes on to fetch jobs for a page it will 404.
    expect(calls.some((call) => call.collection === 'jobs')).toBe(false)
  })

  it('is not found for an empty slug or an unnamed document', async () => {
    const { cms } = fakeCms({ bySlug: { x: { id: 1, slug: 'x' } } })
    expect(await loadOrganisationProfile({ cms, slug: '  ', tenant })).toEqual({ kind: 'not-found' })
    expect(await loadOrganisationProfile({ cms, slug: 'x', tenant })).toEqual({ kind: 'not-found' })
  })

  it('links only a real web address', async () => {
    for (const website of ['javascript:alert(1)', 'not a url', '']) {
      const { cms } = fakeCms({ bySlug: { santo: { ...santo, website } } })
      const result = await loadOrganisationProfile({ cms, slug: 'santo', tenant })
      expect(result.kind === 'found' && result.profile.website).toBeUndefined()
    }
  })

  it('reads the resolved collection slugs, not literals', async () => {
    const calls: string[] = []
    const cms = {
      find: async (collection: string) => {
        calls.push(collection)
        return { docs: [], totalDocs: 0 } as never
      },
      findBySlug: async (collection: string) => {
        calls.push(collection)
        return santo as never
      },
    } as unknown as Pick<CmsClient, 'find' | 'findBySlug'>

    await loadOrganisationProfile({
      cms,
      collections: { jobs: 'vacancies', organisations: 'companies' },
      slug: 'santo-bakery',
      tenant,
    })

    expect(calls).toEqual(['companies', 'vacancies'])
  })
})
