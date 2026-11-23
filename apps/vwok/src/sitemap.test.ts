import type { CacheLike } from '@mission-control/launchpad/cms'
import type { SitemapCms } from '@mission-control/launchpad/seo/serve'
import { describe, expect, it, vi } from 'vitest'

import { GET as shardRoute } from './pages/sitemap-[shard].xml'
import { siteSitemap } from './sitemap'

const NOW = new Date('2026-06-01T00:00:00Z')
const SITE = 'https://vanuatuwok.vu'
const ENV = { CMS_URL: 'https://cms.example.com', SITE_KEY: 'sk_test' }

const docs: Record<string, unknown[]> = {
  'job-categories': [{ id: 1, slug: 'hospitality' }],
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
  organisations: [],
  pages: [{ id: 1, role: 'home', slug: null }],
}

const fakeCms = (): SitemapCms => ({
  findAll: vi.fn(async (collection: string) => docs[collection] ?? []),
})

/** An in-memory Cache API, matching the surface the theme's cache helper uses. */
const memoryCache = (): CacheLike => {
  const store = new Map<string, Response>()
  return {
    match: async (request: Request) => store.get(request.url),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response)
    },
  }
}

describe('siteSitemap @S-123', () => {
  it('serves the sitemap from the CMS over the canonical origin', async () => {
    const response = await siteSitemap({
      cache: memoryCache(),
      cms: fakeCms(),
      env: ENV,
      now: NOW,
      path: '/sitemap.xml',
      siteUrl: SITE,
    })

    const xml = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8')
    expect(xml).toContain(`<loc>${SITE}/jobs/head-chef/</loc>`)
    expect(xml).toContain(`<loc>${SITE}/jobs/category/hospitality/</loc>`)
  })

  it('answers 404 rather than an empty sitemap when the CMS is not configured', async () => {
    for (const env of [{}, { CMS_URL: 'https://cms.example.com' }, { SITE_KEY: 'sk_test' }]) {
      const response = await siteSitemap({ env, path: '/sitemap.xml', siteUrl: SITE })

      expect(response.status).toBe(404)
      // Never cached: the moment the key lands, the next request must build the real sitemap.
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('404s a shard a site this size does not have', async () => {
    const response = await siteSitemap({
      cache: memoryCache(),
      cms: fakeCms(),
      env: ENV,
      now: NOW,
      path: '/sitemap-2.xml',
      siteUrl: SITE,
    })

    expect(response.status).toBe(404)
  })

  it('asks the CMS for live jobs only, so an expired job never reaches the builder', async () => {
    const findAll = vi.fn(async (collection: string) => docs[collection] ?? [])

    await siteSitemap({
      cache: memoryCache(),
      cms: { findAll },
      env: ENV,
      now: NOW,
      path: '/sitemap.xml',
      siteUrl: SITE,
    })

    type FindAllArgs = [collection: string, query?: { where?: unknown }]
    const calls = findAll.mock.calls as unknown as FindAllArgs[]
    const jobsQuery = calls.find(([collection]) => collection === 'jobs')?.[1]

    expect(JSON.stringify(jobsQuery?.where)).toContain(NOW.toISOString())
    expect(JSON.stringify(jobsQuery?.where)).toContain('"status":{"equals":"published"}')
  })
})

/** The two fields the route reads; Astro's own context is far wider than this. */
const callShardRoute = async (pathname: string): Promise<Response> =>
  await (shardRoute as unknown as (context: unknown) => Promise<Response>)({
    site: new URL(SITE),
    url: new URL(`${SITE}${pathname}`),
  })

describe('the shard route @S-123', () => {
  it('404s a name that is not a shard, before it reads the CMS', async () => {
    for (const pathname of ['/sitemap-latest.xml', '/sitemap-0.xml']) {
      const response = await callShardRoute(pathname)

      expect(response.status).toBe(404)
      // No CMS is configured in this test: reaching the loader would have answered differently.
      expect(await response.text()).toBe('Not found')
    }
  })

  it('hands a real shard number to the sitemap, which 404s one the plan does not have', async () => {
    const response = await callShardRoute('/sitemap-1.xml')

    expect(response.status).toBe(404)
    expect(await response.text()).toBe('Sitemap is not configured')
  })
})
