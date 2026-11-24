import { describe, expect, it, vi } from 'vitest'

import type { CacheLike } from '../cms/cache'
import type { SiteTenant } from '../tenant/types'
import {
  loadSitemap,
  serveSitemap,
  SITEMAP_TTL_SECONDS,
  sitemapShardNumber,
  type SitemapCms,
} from './serve'

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
  'job-categories': [
    { id: 1, slug: 'hospitality' },
    { id: 2, slug: 'trades' },
  ],
  jobs: [
    {
      categories: [{ id: 1 }],
      jobType: { id: 20 },
      location: [{ id: 11 }],
      slug: 'head-chef',
      updatedAt: '2026-05-01T00:00:00.000Z',
    },
  ],
  'job-types': [{ id: 20, isVolunteer: false, slug: 'full-time' }],
  locations: [
    { id: 10, parent: null, slug: 'vanuatu' },
    { id: 11, parent: 10, slug: 'efate' },
  ],
  organisations: [{ slug: 'santo-bakery', updatedAt: '2026-05-02T00:00:00.000Z' }],
  pages: [
    { id: 1, role: 'home', slug: null },
    { id: 2, seo: { noIndex: false }, slug: 'about' },
    { id: 3, seo: { noIndex: true }, slug: 'hidden' },
    { id: 4, _status: 'draft', slug: 'draft-page' },
  ],
}

type FindAllCall = { collection: string; query?: Record<string, unknown> }

const fakeCms = () => {
  const calls: FindAllCall[] = []
  const findAll = vi.fn(async (collection: string, query?: Record<string, unknown>) => {
    calls.push({ collection, query })
    return docs[collection] ?? []
  })

  return { calls, cms: { findAll } as SitemapCms }
}

/** An in-memory Cache API, the same surface `cachedResponse` uses. */
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

/**
 * A tiny evaluator for the subset of Payload's `where` that `liveJobsWhere` uses. Enough to prove
 * the loader's query really excludes an expired job, without standing up Payload.
 */
type Where = {
  and?: Where[]
  or?: Where[]
  [field: string]: unknown
}

const matches = (doc: Record<string, unknown>, where: Where): boolean => {
  if (where.and) return where.and.every((clause) => matches(doc, clause))
  if (where.or) return where.or.some((clause) => matches(doc, clause))

  return Object.entries(where).every(([field, condition]) => {
    const value = doc[field]
    const op = condition as Record<string, unknown>
    if ('equals' in op) return value === op.equals
    if ('greater_than' in op) return value != null && String(value) > String(op.greater_than)
    if ('exists' in op) return (value !== null && value !== undefined) === op.exists
    throw new Error(`matches: unsupported condition on ${field}`)
  })
}

describe('loadSitemap @S-123', () => {
  it('asks for live jobs, public organisations and published pages only', async () => {
    const { calls, cms } = fakeCms()
    await loadSitemap({ cms, now: NOW, tenant })

    const queryFor = (collection: string) => calls.find((call) => call.collection === collection)?.query

    expect(JSON.stringify(queryFor('jobs'))).toContain('"status":{"equals":"published"}')
    expect(JSON.stringify(queryFor('jobs'))).toContain(NOW.toISOString())
    // No where: the CMS only returns organisations it calls public to a site key (PJ-38).
    expect(queryFor('organisations')).toEqual({})
    expect(queryFor('pages')).toEqual({ draft: false })
  })

  it('leaves a noindex or draft page out of the sitemap', async () => {
    const { cms } = fakeCms()
    const { entries } = await loadSitemap({ cms, now: NOW, tenant })
    const paths = entries.map((entry) => entry.path)

    expect(paths).toContain('/about')
    expect(paths).not.toContain('/hidden')
    expect(paths).not.toContain('/draft-page')
  })

  it('builds the taxonomy pages from the live jobs it fetched', async () => {
    const { cms } = fakeCms()
    const { entries } = await loadSitemap({ cms, now: NOW, tenant })

    expect(entries.map((entry) => entry.path)).toEqual([
      '/',
      '/jobs',
      '/jobs/category/hospitality',
      '/jobs/type/full-time',
      '/jobs/head-chef',
      '/organisations',
      '/organisations/santo-bakery',
      '/about',
    ])
  })

  it('leaves an expired job out, so a dead page is never advertised', async () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const base = {
      categories: [{ id: 1 }],
      jobType: { id: 20 },
      location: [{ id: 11 }],
      status: 'published',
    }
    const withExpiry = (slug: string, expiresAt: null | string) => ({ ...base, expiresAt, slug })
    const cms = {
      findAll: async (collection: string, query?: { where?: unknown }) =>
        collection === 'jobs'
          ? [
              withExpiry('still-open', '2026-12-01T00:00:00.000Z'),
              withExpiry('no-expiry', null),
              withExpiry('already-closed', '2026-10-01T00:00:00.000Z'),
            ].filter((job) => matches(job, query?.where as Where))
          : (docs[collection] ?? []),
    }

    const { entries } = await loadSitemap({ cms, now, tenant })
    const listed = entries.map((entry) => entry.path)

    expect(listed).toContain('/jobs/still-open')
    expect(listed).toContain('/jobs/no-expiry')
    expect(listed).not.toContain('/jobs/already-closed')
  })

  it('uses the slugs a site passes, so a renamed collection still resolves', async () => {
    const { calls, cms } = fakeCms()
    await loadSitemap({ cms, now: NOW, slugs: { jobs: 'vacancies' }, tenant })

    expect(calls.map((call) => call.collection)).toContain('vacancies')
    expect(calls.map((call) => call.collection)).not.toContain('jobs')
  })
})

describe('serveSitemap @S-123', () => {
  it('serves /sitemap.xml as XML with a cache header', async () => {
    const { cms } = fakeCms()
    const response = await serveSitemap({
      cms,
      now: NOW,
      path: '/sitemap.xml',
      site: 'vwok',
      siteUrl: 'https://vanuatuwok.vu',
      tenant,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(await body(response)).toContain('<loc>https://vanuatuwok.vu/jobs/head-chef/</loc>')
  })

  it('holds the sitemap at the edge, so a second request does not touch the CMS', async () => {
    const { cms } = fakeCms()
    const { cache, store } = memoryCache()
    const options = {
      cache,
      cms,
      now: NOW,
      path: '/sitemap.xml',
      site: 'vwok',
      siteUrl: 'https://vanuatuwok.vu',
      tenant,
    }

    await serveSitemap(options)
    const findAll = cms.findAll as unknown as ReturnType<typeof vi.fn>
    const afterFirst = findAll.mock.calls.length
    await serveSitemap(options)

    expect(findAll.mock.calls.length).toBe(afterFirst)
    expect(store.size).toBeGreaterThan(0)
  })

  it('writes the ttl and the purge tags into the stored entry', async () => {
    const { cms } = fakeCms()
    const { cache, store } = memoryCache()
    await serveSitemap({
      cache,
      cms,
      now: NOW,
      path: '/sitemap.xml',
      site: 'vwok',
      siteUrl: 'https://vanuatuwok.vu',
      tenant,
    })

    const entry = [...store.values()][0]!
    expect(entry.headers.get('cache-control')).toBe(`public, max-age=${SITEMAP_TTL_SECONDS}`)
    expect(entry.headers.get('cache-tag')).toBe('site:vwok,site:vwok:sitemap')
  })

  it('caches /sitemap.xml and /sitemap.xml/ as one answer, since Astro treats them alike', async () => {
    const { cms } = fakeCms()
    const { cache, store } = memoryCache()
    const options = {
      cache,
      cms,
      now: NOW,
      site: 'vwok',
      siteUrl: 'https://vanuatuwok.vu',
      tenant,
    }

    expect((await serveSitemap({ ...options, path: '/sitemap.xml/' })).status).toBe(200)
    expect(store.size).toBe(1)
  })

  it('serves a shard and 404s one the plan does not have', async () => {
    const { cms } = fakeCms()
    const options = { cms, now: NOW, site: 'vwok', siteUrl: 'https://vanuatuwok.vu', tenant }

    // A site this size fits in one file, so there is no shard 1 to serve.
    const missing = await serveSitemap({ ...options, path: '/sitemap-1.xml' })
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')
  })
})

describe('sitemapShardNumber @S-123', () => {
  it('reads the shard from a shard path, with or without a trailing slash', () => {
    expect(sitemapShardNumber('/sitemap-1.xml')).toBe(1)
    expect(sitemapShardNumber('/sitemap-12.xml/')).toBe(12)
  })

  it('refuses a path that does not name a shard, so it never reaches the loader', () => {
    for (const path of ['/sitemap.xml', '/sitemap-0.xml', '/sitemap-latest.xml', '/sitemap-.xml', '/jobs']) {
      expect(sitemapShardNumber(path)).toBeNull()
    }
  })

  it('keeps a shard number unusable when it is too large to be exact', () => {
    expect(sitemapShardNumber('/sitemap-99999999999999999999.xml')).toBeNull()
  })
})
