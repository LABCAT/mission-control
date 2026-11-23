import { describe, expect, it, vi } from 'vitest'

import {
  jobFilterDefinitions,
  jobFilterControls,
  jobListingRoute,
  listingCache,
  jobListingCacheTags,
  jobListingView,
  listingHref,
  listingWhere,
  loadJobListing,
  locationDescendantIDs,
  type LoadJobListingOptions,
  serveJobListing,
  toJobSummary,
  JOB_LISTING_HTML_TTL_SECONDS,
  JOB_LISTING_PAGE_SIZE,
  type ListingFacets,
  type ListingJob,
} from './listing'
import { createMemoryContentVersionStore } from '@mission-control/content-cache'

import { purgeTags, type CacheLike } from '../cms/cache'
import type { CmsList } from '../cms/types'
import type { SiteTenant } from '../tenant/types'

const NOW = new Date('2026-06-01T00:00:00Z')

const tenant: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const facets: ListingFacets = {
  categories: [
    { id: 1, name: 'Hospitality', slug: 'hospitality' },
    { id: 2, name: 'Trades', slug: 'trades' },
  ],
  locations: [
    { id: 10, name: 'Vanuatu', parentID: null, slug: 'vanuatu' },
    { id: 11, name: 'Efate', parentID: 10, slug: 'efate' },
    { id: 12, name: 'Port Vila', parentID: 11, slug: 'port-vila' },
    { id: 13, name: 'Malampa', parentID: null, slug: 'malampa' },
  ],
  types: [
    { id: 20, isVolunteer: false, name: 'Full time', slug: 'full-time' },
    { id: 22, isVolunteer: true, name: 'Voluntary', slug: 'voluntary' },
  ],
}

const job = (overrides: Partial<ListingJob> = {}): ListingJob => ({
  companyName: 'Vanuatu Wok',
  expiresAt: '2026-12-01T00:00:00Z',
  id: 101,
  jobType: { id: 20, isVolunteer: false, name: 'Full time', slug: 'full-time' },
  location: { id: 12, name: 'Port Vila', slug: 'port-vila' },
  organisation: { id: 201, name: 'Vanuatu Wok', slug: 'vanuatu-wok' },
  slug: 'head-chef',
  title: 'Head Chef',
  ...overrides,
})

const definitions = jobFilterDefinitions(facets)

const listOf = (docs: Partial<ListingJob>[], overrides: Partial<CmsList<never>> = {}): CmsList<never> => {
  const totalDocs = overrides.totalDocs ?? docs.length
  const limit = overrides.limit ?? JOB_LISTING_PAGE_SIZE
  const page = overrides.page ?? 1

  return {
    docs: docs as never[],
    hasNextPage: false,
    hasPrevPage: false,
    limit,
    page,
    totalDocs,
    totalPages: Math.max(1, Math.ceil(totalDocs / limit)),
    ...overrides,
  }
}

type ListingCms = LoadJobListingOptions['cms']

/**
 * A CMS client that answers the three taxonomy reads and the jobs query from `answer`. The
 * generic `CmsClient` is narrowed to the two reads the listing makes; the cast is the seam
 * between the real client's generics and a hand-written fake.
 */
const fakeCms = (answer: (options: { page: number }) => CmsList<never>) => {
  const findAll = vi.fn(async (collection: string, _options: { locale?: string; sort?: string }) => {
    if (collection === 'job-categories') return facets.categories
    if (collection === 'job-types') return facets.types
    if (collection === 'locations') return facets.locations
    return []
  })
  const find = vi.fn(async (_collection: string, options: { page: number }) => answer(options))

  return { cms: { findAll, find } as unknown as ListingCms, findAll, find }
}

describe('locationDescendantIDs', () => {
  it('covers the whole subtree, so an island lists its towns', () => {
    expect(locationDescendantIDs(facets.locations, 'efate')).toEqual([11, 12])
    expect(locationDescendantIDs(facets.locations, 'vanuatu')).toEqual([10, 11, 12])
  })

  it('is just the town for a leaf, and empty for a slug the tenant does not have', () => {
    expect(locationDescendantIDs(facets.locations, 'port-vila')).toEqual([12])
    expect(locationDescendantIDs(facets.locations, 'atlantis')).toEqual([])
  })

  it('does not loop on a parent cycle', () => {
    const looped: ListingFacets['locations'] = [
      { id: 1, name: 'A', parentID: 2, slug: 'a' },
      { id: 2, name: 'B', parentID: 1, slug: 'b' },
    ]

    expect(locationDescendantIDs(looped, 'a')).toEqual([1, 2])
  })
})

const baseWhere = (filters: Record<string, string>) =>
  JSON.stringify(listingWhere({ facets, filters, now: NOW }))

describe('listingWhere', () => {
  it('asks for live jobs only: published, and not past an expiry that exists', () => {
    const where = listingWhere({ facets, filters: {}, now: NOW })

    expect(where.and).toEqual(
      expect.arrayContaining([
        { status: { equals: 'published' } },
        {
          or: [
            { expiresAt: { greater_than: NOW.toISOString() } },
            { expiresAt: { exists: false } },
          ],
        },
      ]),
    )
  })

  it('searches the job title and the company name for a keyword', () => {
    const where = listingWhere({ facets, filters: { q: '  chef ' }, now: NOW })

    expect(where.and).toContainEqual({
      or: [{ companyName: { like: 'chef' } }, { title: { like: 'chef' } }],
    })
  })

  it('matches a category, a type or a location by the slug the URL carried', () => {
    expect(baseWhere({ category: 'trades' })).toContain('"categories":{"in":[2]}')
    expect(baseWhere({ type: 'voluntary' })).toContain('"jobType":{"equals":22}')
    expect(baseWhere({ location: 'efate' })).toContain('"location":{"in":[11,12]}')
  })

  it('ignores a filter value the tenant does not have', () => {
    const plain = baseWhere({})
    expect(baseWhere({ category: 'nope' })).toBe(plain)
    expect(baseWhere({ type: 'nope' })).toBe(plain)
    expect(baseWhere({ location: 'nope' })).toBe(plain)
  })

  it('keeps voluntary jobs out by default, without dropping jobs that have no type at all', () => {
    expect(baseWhere({})).toContain('"jobType":{"not_in":[22]}')
    expect(baseWhere({})).toContain('"jobType":{"exists":false}')
  })

  it('includes voluntary jobs when the filter asks, or when a voluntary type is chosen', () => {
    expect(baseWhere({ voluntary: '1' })).not.toContain('not_in')
    expect(baseWhere({ type: 'voluntary' })).not.toContain('not_in')
  })
})

describe('toJobSummary', () => {
  it('maps a populated document, and leaves out what the job does not have', () => {
    const summary = toJobSummary(job({ displayedSalary: ' Vt 150,000 a month ' }))

    expect(summary).toEqual({
      closes: '2026-12-01T00:00:00Z',
      displayedSalary: 'Vt 150,000 a month',
      jobType: 'Full time',
      location: 'Port Vila',
      organisation: { name: 'Vanuatu Wok', url: '/organisations/vanuatu-wok' },
      title: 'Head Chef',
      url: '/jobs/head-chef',
    })
  })

  it('marks a voluntary job, and omits empty optional fields entirely', () => {
    const summary = toJobSummary(
      job({
        companyName: null,
        expiresAt: null,
        jobType: { id: 22, isVolunteer: true, name: 'Voluntary', slug: 'voluntary' },
        location: null,
      }),
    )

    expect(summary).toMatchObject({ isVolunteer: true, jobType: 'Voluntary' })
    expect(summary).not.toHaveProperty('closes')
    expect(summary).not.toHaveProperty('location')
    expect(summary).not.toHaveProperty('displayedSalary')
  })

  it('falls back to the company name when the organisation is not populated, with no org link', () => {
    const summary = toJobSummary(job({ companyName: 'Blue Lagoon Tours', organisation: 201 }))

    expect(summary?.organisation).toEqual({ name: 'Blue Lagoon Tours' })
  })

  it('refuses a job the page could not render: no slug, no title, no attribution', () => {
    expect(toJobSummary(job({ slug: null }))).toBeNull()
    expect(toJobSummary(job({ title: '  ' }))).toBeNull()
    expect(toJobSummary(job({ companyName: null, organisation: null }))).toBeNull()
  })

  it('lets the site app decide the URLs, for the hub linking to the tenant site', () => {
    const summary = toJobSummary(job(), {
      job: (row) => `https://vanuatuwok.vu/jobs/${row.slug}/`,
      organisation: (org) => `https://vanuatuwok.vu/organisations/${org.slug}/`,
    })

    expect(summary?.url).toBe('https://vanuatuwok.vu/jobs/head-chef/')
    expect(summary?.organisation.url).toBe('https://vanuatuwok.vu/organisations/vanuatu-wok/')
  })
})

describe('jobListingRoute', () => {
  it('maps the listing and its sections to a base path and a locked filter', () => {
    expect(jobListingRoute('/jobs')).toEqual({ basePath: '/jobs', locked: {} })
    expect(jobListingRoute('/jobs/')).toEqual({ basePath: '/jobs', locked: {} })
    expect(jobListingRoute('/jobs/category/hospitality')).toEqual({
      basePath: '/jobs/category/hospitality',
      locked: { category: 'hospitality' },
    })
    expect(jobListingRoute('/jobs/type/full-time/')).toEqual({
      basePath: '/jobs/type/full-time',
      locked: { type: 'full-time' },
    })
  })

  it('decodes a slug, so a section with a non-ASCII slug resolves', () => {
    expect(jobListingRoute('/jobs/category/caf%C3%A9')).toEqual({
      basePath: '/jobs/category/caf%C3%A9',
      locked: { category: 'café' },
    })
  })

  it('is null for anything that is not a listing path, including a malformed escape', () => {
    expect(jobListingRoute('/')).toBeNull()
    expect(jobListingRoute('/jobs/head-chef')).toBeNull()
    expect(jobListingRoute('/jobs/category')).toBeNull()
    expect(jobListingRoute('/jobs/category/a/b')).toBeNull()
    expect(jobListingRoute('/organisations')).toBeNull()
    expect(jobListingRoute('/jobs/category/%E0%A4%A')).toBeNull()
    expect(jobListingRoute('/jobs/category/')).toBeNull()
  })
})

const hrefFor = (filters: Record<string, string>, page: number, lockedKeys: string[] = []) =>
  listingHref({ basePath: '/jobs', definitions, filters, lockedKeys, page })

describe('listingHref', () => {
  it('is the bare path for page 1 with no filters, so one listing has one URL', () => {
    expect(hrefFor({}, 1)).toBe('/jobs')
  })

  it('sorts the filters by name so a link is already canonical, with the page number last', () => {
    expect(hrefFor({ location: 'port-vila', page: '2', q: 'chef', category: 'hospitality' }, 2)).toBe(
      '/jobs?category=hospitality&location=port-vila&q=chef&page=2',
    )
  })

  it('never repeats a filter the route already fixes', () => {
    expect(hrefFor({ category: 'trades', page: '1' }, 2, ['category'])).toBe('/jobs?page=2')
  })

  it('drops a filter value that is not allowed rather than passing it on', () => {
    expect(hrefFor({ category: 'ceo' }, 1)).toBe('/jobs')
  })
})

const emptyView = (total: number, page = 1) =>
  jobListingView({
    basePath: '/jobs',
    definitions,
    facets,
    filters: {},
    jobs: [],
    page,
    pageSize: 20,
    total,
  })

describe('jobListingView', () => {
  it('summarises a page with an en dash and clamps an impossible page number', () => {
    expect(emptyView(137, 2).summary).toBe('Showing 21–40 of 137 jobs')
    expect(emptyView(137, 99).page).toBe(7)
    expect(emptyView(137, 0).page).toBe(1)
    expect(emptyView(0).summary).toBe('No jobs found')
  })

  it('renders twenty jobs a page, and one page for an empty listing', () => {
    expect(JOB_LISTING_PAGE_SIZE).toBe(20)
    expect(emptyView(0).totalPages).toBe(1)
    expect(emptyView(41).totalPages).toBe(3)
  })

  it('only counts query-string filters as active, not the section in the path', () => {
    const section = jobListingView({
      basePath: '/jobs/category/trades',
      definitions,
      facets,
      filters: { category: 'trades' },
      jobs: [],
      lockedKeys: ['category'],
      page: 1,
      total: 0,
    })

    expect(section.hasActiveFilters).toBe(false)
    expect(section.formAction).toBe('/jobs')
  })

})

describe('jobFilterControls', () => {
  it('shows one control per filter the listing owns, in order, with the tenant taxonomy as options', () => {
    const controls = jobFilterControls(facets)

    expect(controls.map((control) => control.name)).toEqual(['q', 'category', 'type', 'location', 'voluntary'])
    expect(controls.map((control) => control.type)).toEqual(['search', 'select', 'select', 'select', 'checkbox'])

    const category = controls[1]
    expect(category.type === 'select' && category.options).toEqual([
      { label: 'Hospitality', value: 'hospitality' },
      { label: 'Trades', value: 'trades' },
    ])
    // Voluntary is off unless ticked, so the box sends `1` and nothing when unticked.
    expect(controls[4]).toMatchObject({ name: 'voluntary', type: 'checkbox', value: '1' })
  })

  it('shows every type, including the voluntary one, so a section is reachable from the form', () => {
    const types = jobFilterControls(facets)[2]
    expect(types.type === 'select' && types.options.map((option) => option.value)).toContain('voluntary')
  })
})

const keyFor = (search: string, basePath = '/jobs', site = 'vwok', lockedKeys: string[] = []) =>
  listingCache({ basePath, lockedKeys, search, site })

describe('listingCache', () => {

  it('caches the HTML for five minutes under a site-scoped key and purge tags', () => {
    const cache = keyFor('')

    expect(cache.ttl).toBe(JOB_LISTING_HTML_TTL_SECONDS)
    expect(cache.ttl).toBe(300)
    expect(cache.key).toBe('vwok:html:0:/jobs')
    expect(cache.tags).toEqual(['site:vwok', 'site:vwok:jobs'])
  })

  it('gives each filter set and each site its own entry', () => {
    expect(keyFor('?q=chef').key).toBe('vwok:html:0:/jobs?q=chef')
    expect(keyFor('?category=trades&location=port-vila').key).toBe(
      'vwok:html:0:/jobs?category=trades&location=port-vila',
    )
    expect(keyFor('?q=chef', '/jobs', 'hub').key).toBe('hub:html:0:/jobs?q=chef')
  })

  it('keeps the URL canonical, so one listing has one entry', () => {
    // Parameter order, `?page=1` and a dropped parameter all describe the same page.
    expect(keyFor('?q=chef&location=port-vila').key).toBe('vwok:html:0:/jobs?location=port-vila&q=chef')
    expect(keyFor('?page=1')).toEqual(keyFor(''))
    expect(keyFor('?utm_source=newsletter').key).toBe('vwok:html:0:/jobs')
    expect(keyFor('?q=chef&utm_source=newsletter').key).toBe('vwok:html:0:/jobs?q=chef')
  })

  it('does not repeat a filter the path already fixed, so a section has one entry', () => {
    expect(keyFor('?category=trades', '/jobs/category/trades', 'vwok', ['category']).key).toBe(
      'vwok:html:0:/jobs/category/trades',
    )
    // The path wins over the query, so a stale `?category=` cannot make the section a second entry.
    expect(keyFor('?category=hospitality', '/jobs/category/trades', 'vwok', ['category']).key).toBe(
      'vwok:html:0:/jobs/category/trades',
    )
    // The section's own pages stay distinct.
    expect(keyFor('?page=2', '/jobs/category/trades', 'vwok', ['category']).key).toBe(
      'vwok:html:0:/jobs/category/trades?page=2',
    )
  })

  it('carries the page number, so page 2 is not served page 1', () => {
    expect(keyFor('?page=2').key).toBe('vwok:html:0:/jobs?page=2')
    expect(keyFor('?q=chef&page=2').key).toBe('vwok:html:0:/jobs?q=chef&page=2')
  })

  it('drops a value that could not be a filter, so the cache cannot be filled with junk', () => {
    // A long keyword is cut, not dropped: dropping it would key the search as the bare listing.
    expect(keyFor('?q=' + 'x'.repeat(500)).key).toBe(`vwok:html:0:/jobs?q=${'x'.repeat(100)}`)
    expect(keyFor('?category=%3Cscript%3E').key).toBe('vwok:html:0:/jobs')
    expect(keyFor('?page=abc').key).toBe('vwok:html:0:/jobs')
    // Past the last real page every number is the same listing, so it is one entry, not a million.
    expect(keyFor('?page=999999999').key).toBe('vwok:html:0:/jobs?page=500')
    expect(keyFor('?voluntary=yes').key).toBe('vwok:html:0:/jobs')
  })

  it('is the same for the same request and scoped per tenant', () => {
    expect(keyFor('?q=chef')).toEqual(keyFor('?q=chef'))
    expect(jobListingCacheTags('vwok')).toEqual(['site:vwok', 'site:vwok:jobs'])
  })
})

describe('loadJobListing', () => {
  it('loads the taxonomies, the filters and one page of jobs', async () => {
    const { cms, find } = fakeCms(() => listOf([job(), job({ id: 102, slug: 'clerk', title: 'Clerk' })]))

    const result = await loadJobListing({ cms, now: NOW, search: 'q=chef&page=1', tenant })

    expect(result.found).toBe(true)
    if (!result.found) throw new Error('expected a view')
    expect(result.view.jobs).toHaveLength(2)
    expect(result.view.filters).toEqual({ q: 'chef' })
    expect(result.view.pageSize).toBe(20)

    // The query carries the live-jobs rule and the keyword, and asks for the page limit.
    const [, query] = find.mock.calls[0]! as unknown as [
      string,
      { depth: number; limit: number; where: unknown },
    ]
    expect(query.limit).toBe(20)
    expect(query.depth).toBe(2)
    expect(JSON.stringify(query.where)).toContain('"title":{"like":"chef"}')
  })

  it('drops a query-string value the tenant does not have', async () => {
    const { cms } = fakeCms(() => listOf([]))

    const result = await loadJobListing({ cms, now: NOW, search: 'category=injected', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.filters).toEqual({})
  })

  it('is not found for a section slug the tenant does not have', async () => {
    const { cms, find } = fakeCms(() => listOf([]))

    await expect(
      loadJobListing({
        basePath: '/jobs/category/nope',
        cms,
        locked: { category: 'nope' },
        now: NOW,
        search: '',
        tenant,
      }),
    ).resolves.toEqual({ found: false, reason: 'unknown-category' })

    expect(find).not.toHaveBeenCalled()
  })

  it('serves the last page when the URL asks for one past the end', async () => {
    const { cms, find } = fakeCms((options: { page: number }) =>
      options.page === 99
        ? listOf([], { limit: 20, page: 99, totalDocs: 25 })
        : listOf([job()], { limit: 20, page: 2, totalDocs: 25 }),
    )

    const result = await loadJobListing({ cms, now: NOW, search: 'page=99', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.page).toBe(2)
    expect(find).toHaveBeenLastCalledWith('jobs', expect.objectContaining({ page: 2 }))
  })

  it('applies a long keyword instead of silently showing everything, as the cache key assumes', async () => {
    // The regression: the key cut the keyword to 100 characters while the loader kept all 500, so
    // a search was cached under the bare listing's key and every visitor got its results.
    const { cms, find } = fakeCms(() => listOf([]))
    const keyword = 'x'.repeat(500)

    const result = await loadJobListing({ cms, now: NOW, search: `q=${keyword}`, tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.filters.q).toHaveLength(100)
    const [, query] = find.mock.calls[0]! as unknown as [string, { where: unknown }]
    expect(JSON.stringify(query.where)).toContain(`"like":"${'x'.repeat(100)}"`)
  })

  it('serves the page the cache key names, so a stored page is never the HTML of another', async () => {
    // Either side clamping differently would store one page under another page's key.
    const { cms, find } = fakeCms(() => listOf([job()], { limit: 20, page: 1, totalDocs: 5000 }))

    await loadJobListing({ cms, now: NOW, search: '?page=999999999', tenant })

    expect(find).toHaveBeenLastCalledWith('jobs', expect.objectContaining({ page: 500 }))
  })

  it('agrees with the cache key for the same URL, which is what keeps a hit correct', async () => {
    const searches = ['', '?q=chef', '?q=' + 'y'.repeat(400), '?page=7', '?page=999999', '?category=trades&page=3']

    for (const search of searches) {
      const cache = listingCache({ basePath: '/jobs', search, site: 'vwok' })
      const { cms, find } = fakeCms(() => listOf([job()], { limit: 20, page: 1, totalDocs: 5000 }))

      const result = await loadJobListing({ cms, now: NOW, search, tenant })
      if (!result.found) throw new Error('expected a view')

      const [, query] = find.mock.calls[0]! as unknown as [string, { page: number }]
      const keyPage = cache.key.includes('page=') ? Number(cache.key.split('page=')[1]) : 1

      // The key's page is the page queried, unless the CMS answered a different one because the
      // listing is shorter; here it holds 5,000 jobs, so the clamp is all that applies.
      expect(keyPage).toBe(Math.min(query.page, 500))
      // The key's filters are the filters the view carries.
      const keyQuery = new URLSearchParams(cache.key.includes('?') ? cache.key.slice(cache.key.indexOf('?')) : '')
      for (const [name, value] of keyQuery) {
        if (name === 'page') continue
        expect(result.view.filters[name]).toBe(value)
      }
    }
  })

  it('asks for every read in the tenant locale, so labels and titles are in its language', async () => {
    // `title` and taxonomy `name` are localized fields. Omitting `locale` gives Payload's default,
    // so a French site would show English labels and English job titles.
    const { cms, findAll, find } = fakeCms(() => listOf([job()]))
    const french: SiteTenant = { ...tenant, defaultLocale: 'fr' }

    const result = await loadJobListing({ cms, now: NOW, search: '?q=chef', tenant: french })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.locale).toBe('fr')
    for (const call of findAll.mock.calls) {
      expect(call[1]).toMatchObject({ locale: 'fr' })
    }
    expect(find.mock.calls[0]![1]).toMatchObject({ locale: 'fr' })
  })

  it('falls back to the tenant default when no locale is set, never to undefined', async () => {
    const { cms, findAll, find } = fakeCms(() => listOf([job()]))
    const plain: SiteTenant = { ...tenant, defaultLocale: null }

    await loadJobListing({ cms, now: NOW, search: '', tenant: plain })

    expect(findAll.mock.calls[0]![1]).toMatchObject({ locale: 'en' })
    expect(find.mock.calls[0]![1]).toMatchObject({ locale: 'en' })
  })

  it('marks a dropped filter as an inexact answer, so it is not stored under that URL', async () => {
    const { cms } = fakeCms(() => listOf([job()]))

    const result = await loadJobListing({ cms, now: NOW, search: '?category=made-up', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.filters).toEqual({})
    expect(result.view.inexact).toBe(true)
  })

  it('is exact for the filters it does apply', async () => {
    const { cms } = fakeCms(() => listOf([job()]))

    const result = await loadJobListing({ cms, now: NOW, search: '?category=trades&q=chef', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.inexact).toBe(false)
  })

  it('marks a page past the end as inexact, because it renders another page', async () => {
    const { cms } = fakeCms((options: { page: number }) =>
      options.page === 99
        ? listOf([], { limit: 20, page: 99, totalDocs: 25 })
        : listOf([job()], { limit: 20, page: 2, totalDocs: 25 }),
    )

    const result = await loadJobListing({ cms, now: NOW, search: '?page=99', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.inexact).toBe(true)
  })

  it('drops a job that cannot be rendered rather than failing the page', async () => {
    const { cms } = fakeCms(() => listOf([job(), job({ id: 103, slug: null })]))

    const result = await loadJobListing({ cms, now: NOW, search: '', tenant })

    if (!result.found) throw new Error('expected a view')
    expect(result.view.jobs).toHaveLength(1)
    expect(result.view.total).toBe(2)
  })
})

const pageCache = () => {
  const store = new Map<string, Response>()
  const cache: CacheLike & { store: typeof store } = {
    async match(request) {
      const hit = store.get(request.url)
      return hit ? hit.clone() : undefined
    },
    async put(request, response) {
      store.set(request.url, response.clone())
    },
    store,
  }
  return cache
}

const renderView = (view: { summary: string }) =>
  Promise.resolve(
    new Response(`<html>${view.summary}</html>`, { headers: { 'content-type': 'text/html' }, status: 200 }),
  )

describe('serveJobListing', () => {
  it('renders once and serves the stored HTML on the next request', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))

    const options = { cache, cms, now: NOW, render: renderView, search: '', site: 'vwok', tenant }
    const first = await serveJobListing(options)
    const second = await serveJobListing(options)

    const firstBody = await first.text()
    expect(firstBody).toContain('1 jobs')
    expect(await second.text()).toBe(firstBody)
    expect(first.headers.get('cache-control')).toBe('public, max-age=60')
    expect(first.headers.get('cache-tag')).toBe('site:vwok,site:vwok:jobs')
  })

  it('answers a cache hit without asking the CMS at all', async () => {
    const cache = pageCache()
    const { cms, find } = fakeCms(() => listOf([job()]))
    const options = { cache, cms, now: NOW, render: renderView, search: '?q=chef', site: 'vwok', tenant }

    await serveJobListing(options)
    const calls = find.mock.calls.length
    find.mockClear()

    const hit = await serveJobListing(options)

    expect(await hit.text()).toContain('1 jobs')
    // A five-minute cache that still queries the CMS on every request saves nothing.
    expect(find).not.toHaveBeenCalled()
    expect(calls).toBeGreaterThan(0)
  })

  it('does not store a made-up filter, so junk slugs cannot fill the cache', async () => {
    const cache = pageCache()
    const { cms, find } = fakeCms(() => listOf([job()]))
    const base = { cache, cms, now: NOW, render: renderView, site: 'vwok', tenant }

    const one = await serveJobListing({ ...base, search: '?category=made-up-a' })
    const two = await serveJobListing({ ...base, search: '?category=made-up-b' })

    // Same HTML both times, and neither is kept: the URL claims a filter the listing did not apply.
    expect(await one.text()).toBe(await two.text())
    expect(one.headers.get('cache-control')).toBe('no-store')
    expect([...cache.store.keys()].filter((url) => url.includes('/page/'))).toHaveLength(0)
    expect(find).toHaveBeenCalledTimes(2)
  })

  it('still caches a slug the tenant does have, so real filters are held', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const base = { cache, cms, now: NOW, render: renderView, site: 'vwok', tenant }

    const first = await serveJobListing({ ...base, search: '?category=trades' })

    expect(first.headers.get('cache-control')).toBe('public, max-age=60')
    expect([...cache.store.keys()].filter((url) => url.includes('/page/'))).toHaveLength(1)
  })

  it('gives a different filter set a different entry, so a hit is never the wrong page', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const base = { cache, cms, now: NOW, render: renderView, site: 'vwok', tenant }

    const chef = await serveJobListing({ ...base, search: '?q=chef' })
    const clerk = await serveJobListing({ ...base, search: '?q=clerk' })

    expect(chef.headers.get('cache-tag')).toBe('site:vwok,site:vwok:jobs')
    expect([...cache.store.keys()].filter((url) => url.includes('/page/'))).toHaveLength(2)
    expect(await clerk.text()).toBe(await chef.text())
  })

  it('renders again after the site tag is purged, so a changed job reaches every listing', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const render = vi.fn(renderView)
    const options = { cache, cms, now: NOW, render, search: '', site: 'vwok', tenant }

    await serveJobListing(options)
    await serveJobListing(options)
    expect(render).toHaveBeenCalledTimes(1)

    await purgeTags(jobListingCacheTags('vwok'), { cache })
    await serveJobListing(options)

    expect(render).toHaveBeenCalledTimes(2)
  })

  it('keeps a missing section out of the cache and answers 404', async () => {
    const cache = pageCache()
    const renderSpy = vi.fn(renderView)
    const { cms } = fakeCms(() => listOf([]))

    const response = await serveJobListing({
      cache,
      cms,
      locked: { type: 'nope' },
      basePath: '/jobs/type/nope',
      now: NOW,
      render: renderSpy,
      search: '',
      site: 'vwok',
      tenant,
    })

    expect(response.status).toBe(404)
    expect(renderSpy).not.toHaveBeenCalled()
    expect([...cache.store.keys()].filter((url) => url.includes('/page/'))).toHaveLength(0)
  })

  it('holds the listing for seven days once a content version can invalidate it @S-240', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const store = createMemoryContentVersionStore({ vwok: 'v1' })

    const response = await serveJobListing({ cache, cms, now: NOW, render: renderView, search: '', site: 'vwok', store, tenant })

    // The browser revalidates after a minute; only the stored edge entry is held for seven days.
    expect(response.headers.get('cache-control')).toBe('public, max-age=60')
    const stored = [...cache.store.entries()].find(([url]) => url.includes('/page/'))?.[1]
    expect(stored?.headers.get('cache-control')).toBe('public, max-age=604800')
  })

  it('renders fresh after the content version is bumped, without a purge @S-240', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const store = createMemoryContentVersionStore({ vwok: 'v1' })
    const render = vi.fn(renderView)
    const options = { cache, cms, now: NOW, render, search: '', site: 'vwok', store, tenant }

    await serveJobListing(options)
    await serveJobListing(options)
    expect(render).toHaveBeenCalledTimes(1)

    store.values.set('content-version:vwok', 'v2')
    await serveJobListing(options)

    // The old entry is unreachable rather than purged: the new key has no copy in this colo.
    expect(render).toHaveBeenCalledTimes(2)
  })

  it('accepts a version read once for a whole request, so one page reads KV once @S-240', async () => {
    const cache = pageCache()
    const { cms } = fakeCms(() => listOf([job()]))
    const get = vi.fn(async () => 'v9')
    const store = { get, put: async () => {} }

    await serveJobListing({ cache, cms, now: NOW, render: renderView, search: '', site: 'vwok', store, tenant, version: 'v9' })

    expect(get).not.toHaveBeenCalled()
  })
})
