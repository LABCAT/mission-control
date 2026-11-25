import { describe, expect, it, vi } from 'vitest'

import type { CacheLike } from '../cms/cache'
import type { CmsFindOptions } from '../cms/types'
import type { SiteTenant } from '../tenant/types'
import { LLMS_JOB_LIMIT, loadLlms, serveLlms, type LlmsCms } from './llms-serve'

const NOW = new Date('2026-06-01T00:00:00Z')

const tenant: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const docs: Record<string, unknown[]> = {
  jobs: [
    { slug: 'head-chef', title: 'Head Chef' },
    { slug: 'no-title' },
    { title: 'No slug' },
  ],
  organisations: [{ name: 'Santo Bakery', slug: 'santo-bakery' }, { name: 'No slug' }, { slug: 'no-name' }],
  pages: [
    { id: 1, role: 'home', slug: null, title: 'Home' },
    { id: 2, slug: 'about', title: 'About us' },
    { id: 3, seo: { noIndex: true }, slug: 'legal', title: 'Legal' },
    { id: 4, _status: 'draft', slug: 'draft', title: 'Draft' },
    // A child whose parent is not published has no path, so it cannot be listed.
    { id: 5, parent: 99, slug: 'orphan', title: 'Orphan' },
  ],
}

type Call = { collection: string; query?: CmsFindOptions }

const fakeCms = (overrides: Record<string, unknown[]> = {}) => {
  const calls: Call[] = []
  const findAll = vi.fn(async (collection: string, query?: CmsFindOptions) => {
    calls.push({ collection, query })
    return overrides[collection] ?? docs[collection] ?? []
  })

  return { calls, cms: { findAll } as LlmsCms }
}

const memoryCache = () => {
  const store = new Map<string, Response>()
  const cache: CacheLike = {
    match: async (request: Request) => store.get(request.url),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response)
    },
  }

  return { cache, store }
}

const body = async (response: Response): Promise<string> => await response.clone().text()

describe('loadLlms @S-348', () => {
  it('reads only the live jobs, the public organisations and the published pages', async () => {
    const { calls, cms } = fakeCms()
    await loadLlms({ cms, now: NOW, tenant })

    const queryFor = (collection: string) => calls.find((call) => call.collection === collection)?.query

    expect(queryFor('jobs')?.limit).toBe(LLMS_JOB_LIMIT)
    expect(JSON.stringify(queryFor('jobs')?.where)).toContain('"status":{"equals":"published"}')
    expect(JSON.stringify(queryFor('jobs')?.where)).toContain(NOW.toISOString())
    expect(queryFor('pages')).toEqual({ draft: false, locale: 'en', sort: 'title' })
  })

  it('lists a job with a title and a slug, and skips one missing either', async () => {
    const { cms } = fakeCms()
    const { jobs } = await loadLlms({ cms, now: NOW, tenant })

    expect(jobs).toEqual([{ name: 'Head Chef', path: '/jobs/head-chef' }])
  })

  it('lists a named organisation with a slug, and skips one missing either', async () => {
    const { cms } = fakeCms()
    const { organisations } = await loadLlms({ cms, now: NOW, tenant })

    expect(organisations).toEqual([{ name: 'Santo Bakery', path: '/organisations/santo-bakery' }])
  })

  it('leaves a noindex page, a draft and a home page out, and an orphan with no path', async () => {
    const { cms } = fakeCms()
    const { pages } = await loadLlms({ cms, now: NOW, tenant })
    const paths = (pages ?? []).flatMap((section) => section.links.map((link) => link.path))

    expect(paths).toEqual(['/about'])
  })

  it('leaves a noindex job and a noindex organisation out @S-349', async () => {
    const { cms } = fakeCms({
      jobs: [
        { slug: 'head-chef', title: 'Head Chef' },
        { seo: { noIndex: true }, slug: 'hidden-job', title: 'Hidden' },
      ],
      organisations: [
        { name: 'Santo Bakery', slug: 'santo-bakery' },
        { name: 'Hidden Org', seo: { noIndex: true }, slug: 'hidden-org' },
      ],
    })
    const { jobs, organisations } = await loadLlms({ cms, now: NOW, tenant })

    expect(jobs).toEqual([{ name: 'Head Chef', path: '/jobs/head-chef' }])
    expect(organisations).toEqual([{ name: 'Santo Bakery', path: '/organisations/santo-bakery' }])
  })

  it('honours renamed collection slugs from the plugin options', async () => {
    const { calls, cms } = fakeCms({ companies: docs.organisations })
    await loadLlms({
      cms,
      now: NOW,
      slugs: { jobs: 'vacancies', organisations: 'companies', pages: 'content' },
      tenant,
    })

    expect(calls.map((call) => call.collection)).toEqual(['vacancies', 'companies', 'content'])
  })
})

describe('serveLlms @S-348', () => {
  const SITE = 'https://vanuatuwok.vu'

  it('renders the file as plain text and caches it', async () => {
    const { cms } = fakeCms()
    const { cache, store } = memoryCache()

    const response = await serveLlms({ cache, cms, now: NOW, site: 'vwok', siteUrl: SITE, tenant })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(await body(response)).toContain('# Vanuatu Wok')
    expect(store.size).toBe(1)
  })

  it('answers 404 without a canonical origin, since every URL in the file is absolute', async () => {
    const { calls, cms } = fakeCms()
    const { cache } = memoryCache()

    const response = await serveLlms({ cache, cms, now: NOW, site: 'vwok', siteUrl: null, tenant })

    expect(response.status).toBe(404)
    // And it never asks the CMS for content it cannot name.
    expect(calls).toHaveLength(0)
  })

  it('serves the cached copy on a second request instead of rebuilding it', async () => {
    const { cms } = fakeCms()
    const { cache } = memoryCache()
    const findSpy = cms.findAll as unknown as ReturnType<typeof vi.fn>

    await serveLlms({ cache, cms, now: NOW, site: 'vwok', siteUrl: SITE, tenant })
    const first = findSpy.mock.calls.length
    const second = await serveLlms({ cache, cms, now: NOW, site: 'vwok', siteUrl: SITE, tenant })

    expect(findSpy.mock.calls.length).toBe(first)
    expect(second.status).toBe(200)
  })

  it('stores the entry for the ttl it was given', async () => {
    const { cms } = fakeCms()
    const { cache } = memoryCache()

    const response = await serveLlms({ cache, cms, now: NOW, site: 'vwok', siteUrl: SITE, tenant, ttl: 60 })

    expect(response.headers.get('cache-control')).toBe('public, max-age=60')
  })
})
