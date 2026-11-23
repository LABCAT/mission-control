import { describe, expect, it } from 'vitest'

import {
  absoluteUrl,
  cleanFilterPaths,
  escapeXml,
  filterSitemapEntries,
  jobSitemapEntries,
  pageSitemapEntries,
  pageUrl,
  sitemapEntries,
  sitemapIndexXml,
  sitemapPlan,
  sitemapShards,
  urlsetXml,
  type SitemapFacets,
  type SitemapJob,
  type SitemapPage,
} from './sitemap'

const facets: SitemapFacets = {
  categories: [
    { id: 1, slug: 'hospitality' },
    { id: 2, slug: 'trades' },
    { id: 3, slug: 'it' },
  ],
  locations: [
    { id: 10, parentID: null, slug: 'vanuatu' },
    { id: 11, parentID: 10, slug: 'efate' },
    { id: 12, parentID: 11, slug: 'port-vila' },
    { id: 13, parentID: null, slug: 'malampa' },
  ],
  types: [
    { id: 20, isVolunteer: false, slug: 'full-time' },
    { id: 21, isVolunteer: false, slug: 'part-time' },
    { id: 22, isVolunteer: true, slug: 'voluntary' },
  ],
}

const job = (overrides: Partial<SitemapJob> = {}): SitemapJob => ({
  categories: [{ id: 1 }],
  jobType: { id: 20 },
  location: [{ id: 12 }],
  slug: 'head-chef',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
})

const paths = (entries: { path: string }[]): string[] => entries.map((entry) => entry.path)

describe('filterSitemapEntries @S-123', () => {
  it('lists a category and type page only when it has live jobs', () => {
    const entries = filterSitemapEntries({ facets, jobs: [job()] })

    // The default is the routes `jobListingRoute` serves today, so a listed path is a path the
    // site answers. `/jobs/category/trades` has no job, and an empty page is noindex, so it is
    // never listed. Location pages arrive with their routes (PJ-42).
    expect(paths(entries)).toEqual(['/jobs/category/hospitality', '/jobs/type/full-time'])
    expect(paths(entries)).not.toContain('/jobs/category/trades')
  })

  it('lists the clean one-level URLs a site passes once it serves them', () => {
    const entries = filterSitemapEntries({ facets, filterPaths: cleanFilterPaths, jobs: [job()] })

    // STATUS.md, 19 Nov: `/jobs/{location}/{category}`, location first and no `/in`. A job in
    // Port Vila puts its town, island and country pages in the sitemap as well.
    expect(paths(entries)).toEqual([
      '/jobs/hospitality',
      '/jobs/vanuatu',
      '/jobs/efate',
      '/jobs/port-vila',
      '/jobs/full-time',
      '/jobs/vanuatu/hospitality',
      '/jobs/efate/hospitality',
      '/jobs/port-vila/hospitality',
    ])
  })

  it('leaves out an empty filter page, so the sitemap never advertises a noindex page', () => {
    expect(filterSitemapEntries({ facets, jobs: [] })).toEqual([])
  })

  it('lists a location page once, covering its subtree, when the site serves one', () => {
    const withLocations = {
      category: (slug: string) => `/jobs/category/${slug}`,
      location: (slug: string) => `/jobs/location/${slug}`,
      type: (slug: string) => `/jobs/type/${slug}`,
    }

    const listed = filterSitemapEntries({ facets, filterPaths: withLocations, jobs: [job()] })

    expect(paths(listed)).toEqual([
      '/jobs/category/hospitality',
      '/jobs/location/vanuatu',
      '/jobs/location/efate',
      '/jobs/location/port-vila',
      '/jobs/type/full-time',
    ])
  })

  it('counts a job once per page even when it names two places under one island', () => {
    const twoTowns = job({ location: [{ id: 12 }, { id: 11 }] })
    const counts = filterSitemapEntries({
      facets,
      filterPaths: { location: cleanFilterPaths.location },
      jobs: [twoTowns],
    })

    expect(paths(counts)).toEqual(['/jobs/vanuatu', '/jobs/efate', '/jobs/port-vila'])
  })

  it('leaves a separately listed type out of the other pages, as the listing does', () => {
    const volunteer = job({ categories: [{ id: 2 }], jobType: { id: 22 }, slug: 'beach-clean' })

    // The volunteer type page is listed; the trades page would be empty, so it is not.
    expect(paths(filterSitemapEntries({ facets, jobs: [volunteer] }))).toEqual([
      '/jobs/type/voluntary',
    ])
  })

  it('builds location+category paths only where the pair has jobs', () => {
    const pairs = { 'location-category': cleanFilterPaths['location-category'] }

    expect(paths(filterSitemapEntries({ facets, filterPaths: pairs, jobs: [job()] }))).toEqual([
      '/jobs/vanuatu/hospitality',
      '/jobs/efate/hospitality',
      '/jobs/port-vila/hospitality',
    ])
  })

  it('does not list a location+category page whose place has no job in that category', () => {
    const nested = { 'location-category': (location: string, category: string) => `/jobs/${location}/${category}` }
    const tradesInVila = job({ categories: [{ id: 2 }] })

    expect(paths(filterSitemapEntries({ facets, filterPaths: nested, jobs: [tradesInVila] }))).toEqual([
      '/jobs/vanuatu/trades',
      '/jobs/efate/trades',
      '/jobs/port-vila/trades',
    ])
  })

  it('names no route for a kind the site does not serve', () => {
    const entries = filterSitemapEntries({
      facets,
      filterPaths: { category: (slug) => `/jobs/${slug}` },
      jobs: [job()],
    })

    expect(paths(entries)).toEqual(['/jobs/hospitality'])
  })
})

describe('jobSitemapEntries @S-123', () => {
  it('lists a live job with its last change, and skips a job with no slug', () => {
    expect(jobSitemapEntries([job(), job({ slug: null, updatedAt: null })])).toEqual([
      { lastModified: '2026-11-01T00:00:00.000Z', path: '/jobs/head-chef' },
    ])
  })

  it('encodes a slug so the URL survives the trip', () => {
    expect(paths(jobSitemapEntries([job({ slug: 'chef & cook' })]))).toEqual([
      '/jobs/chef%20%26%20cook',
    ])
  })
})

describe('pageSitemapEntries @S-123', () => {
  const pages: SitemapPage[] = [
    { id: 1, role: 'home', slug: null, updatedAt: '2026-10-01T00:00:00.000Z' },
    { id: 2, role: 'organisations', slug: 'organisations' },
    { id: 3, slug: 'about', updatedAt: '2026-10-02T00:00:00.000Z' },
    { id: 4, parent: 3, slug: 'team' },
    { id: 5, parent: 99, slug: 'orphan' },
  ]

  it('maps a page to its path, walking parents and letting the home page own /', () => {
    expect(paths(pageSitemapEntries(pages))).toEqual([
      '/',
      '/organisations',
      '/about',
      '/about/team',
      '/orphan',
    ])
  })

  it('keeps a page whose parent chain is a loop, without hanging', () => {
    const looped: SitemapPage[] = [
      { id: 1, parent: 2, slug: 'a' },
      { id: 2, parent: 1, slug: 'b' },
    ]

    expect(paths(pageSitemapEntries(looped))).toEqual(['/b/a', '/a/b'])
  })
})

describe('sitemapEntries @S-123', () => {
  it('lists the home page, the listing, live jobs, public organisations and pages', () => {
    const entries = sitemapEntries({
      facets,
      jobs: [job()],
      organisations: [{ slug: 'santo-bakery', updatedAt: '2026-11-02T00:00:00.000Z' }],
      pages: [{ id: 1, role: 'home', slug: null }],
    })

    expect(paths(entries)).toEqual([
      '/',
      '/jobs',
      '/jobs/category/hospitality',
      '/jobs/type/full-time',
      '/jobs/head-chef',
      '/organisations',
      '/organisations/santo-bakery',
    ])
  })

  it('leaves out /jobs and /organisations when there is nothing to show there', () => {
    const entries = sitemapEntries({ facets, jobs: [], organisations: [], pages: [] })

    expect(paths(entries)).toEqual(['/'])
  })

  it('lists a path once, however many sources name it', () => {
    const entries = sitemapEntries({
      facets,
      jobs: [],
      organisations: [],
      pages: [{ id: 1, role: 'home', slug: null }],
    })

    expect(paths(entries).filter((path) => path === '/')).toHaveLength(1)
  })
})

describe('xml @S-123', () => {
  it('builds a urlset with escaped absolute URLs and an ISO lastmod', () => {
    const xml = urlsetXml([{ path: '/' }, { lastModified: '2026-11-01', path: '/jobs/chef & cook' }], {
      siteUrl: 'https://vanuatuwok.vu/',
    })

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    // The same form the theme marks canonical, so a crawler sees one URL per page.
    expect(xml).toContain('<loc>https://vanuatuwok.vu/</loc>')
    expect(xml).toContain('<loc>https://vanuatuwok.vu/jobs/chef &amp; cook/</loc>')
    expect(xml).toContain('<lastmod>2026-11-01T00:00:00.000Z</lastmod>')
  })

  it('drops a lastmod that is not a date rather than writing a broken one', () => {
    expect(
      urlsetXml([{ lastModified: 'not a date', path: '/' }], { siteUrl: 'https://x.vu' }),
    ).not.toContain('<lastmod>')
  })

  it('escapes every character that could end the element early', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    )
  })

  it('builds an index that points at each shard', () => {
    const xml = sitemapIndexXml([{ path: '/sitemap-1.xml' }, { path: '/sitemap-2.xml' }], {
      siteUrl: 'https://vanuatuwok.vu',
    })

    expect(xml).toContain('<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
    expect(xml).toContain('<loc>https://vanuatuwok.vu/sitemap-1.xml</loc>')
    expect(xml).toContain('<loc>https://vanuatuwok.vu/sitemap-2.xml</loc>')
  })

  it('joins a site root and a sitemap path without doubling or dropping a slash', () => {
    expect(absoluteUrl('https://vanuatuwok.vu/', '/sitemap-1.xml')).toBe(
      'https://vanuatuwok.vu/sitemap-1.xml',
    )
    expect(absoluteUrl('https://vanuatuwok.vu', 'sitemap-1.xml')).toBe(
      'https://vanuatuwok.vu/sitemap-1.xml',
    )
  })

  it('writes a page URL the way the theme writes its canonical, so the two agree', () => {
    expect(pageUrl('https://vanuatuwok.vu/', '/jobs/head-chef')).toBe(
      'https://vanuatuwok.vu/jobs/head-chef/',
    )
    expect(pageUrl('https://vanuatuwok.vu', '/')).toBe('https://vanuatuwok.vu/')
  })
})

describe('sitemapPlan @S-123', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ path: `/jobs/${index + 1}` }))

  it('serves one urlset when the site fits in a single file', () => {
    const plan = sitemapPlan({ entries, siteUrl: 'https://vanuatuwok.vu' })

    expect(plan.shards).toEqual([])
    expect(plan.index).toContain('<urlset')
    expect(plan.index).toContain('/jobs/5/</loc>')
  })

  it('splits a large site into shards and an index that names them in order', () => {
    const plan = sitemapPlan({ entries, maxUrls: 2, siteUrl: 'https://vanuatuwok.vu' })

    expect(plan.shards.map((shard) => shard.path)).toEqual([
      '/sitemap-1.xml',
      '/sitemap-2.xml',
      '/sitemap-3.xml',
    ])
    expect(plan.index).toContain('<sitemapindex')
    expect(plan.index).toContain('<loc>https://vanuatuwok.vu/sitemap-3.xml</loc>')
    expect(plan.shards[2]?.xml).toContain('/jobs/5/</loc>')
  })

  it('keeps the order, so a shard holds the same URLs from one build to the next', () => {
    expect(sitemapShards(entries, { maxUrls: 2 }).map(paths)).toEqual([
      ['/jobs/1', '/jobs/2'],
      ['/jobs/3', '/jobs/4'],
      ['/jobs/5'],
    ])
  })

  it('still serves an empty urlset for a site with no URLs yet', () => {
    expect(sitemapShards([], { maxUrls: 2 })).toEqual([[]])
    expect(sitemapPlan({ entries: [], siteUrl: 'https://x.vu' }).shards).toEqual([])
  })
})
