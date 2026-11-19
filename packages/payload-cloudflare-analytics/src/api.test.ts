import { describe, expect, it, vi } from 'vitest'

import { fetchCloudflareAnalytics, mapAnalyticsResponse } from './api'
import { AnalyticsError } from './errors'

type Group = {
  count: number
  dimensions?: Record<string, null | string>
  sum?: { visits: number }
}

const responseWith = (accounts: Record<string, Group[]>) => ({
  data: { viewer: { accounts: [accounts] } },
})

describe('response mapping', () => {
  it('maps totals, sorts and limits top pages and referrers, and sorts the daily series', () => {
    const data = mapAnalyticsResponse(
      responseWith({
        daily: [
          { count: 3, dimensions: { date: '2026-11-15' }, sum: { visits: 1 } },
          { count: 8, dimensions: { date: '2026-11-14' }, sum: { visits: 2 } },
        ],
        pages: [
          { count: 2, dimensions: { requestPath: '/jobs' } },
          { count: 9, dimensions: { requestPath: '/jobs/site-manager' } },
          { count: 4, dimensions: { requestPath: '/about' } },
          { count: 1, dimensions: { requestPath: null } },
        ],
        referrers: [
          { count: 3, dimensions: { refererHost: 'news.example.com' } },
          { count: 5, dimensions: { refererHost: 'search.example.com' } },
          { count: 2, dimensions: { refererHost: '' } },
        ],
        totals: [{ count: 11, sum: { visits: 4 } }],
      }),
      7,
    )

    expect(data.visits).toBe(4)
    expect(data.pageViews).toBe(11)
    expect(data.range).toBe(7)
    expect(data.topPages).toEqual([
      { path: '/jobs/site-manager', views: 9 },
      { path: '/about', views: 4 },
      { path: '/jobs', views: 2 },
    ])
    expect(data.topReferrers).toEqual([
      { host: 'search.example.com', views: 5 },
      { host: 'news.example.com', views: 3 },
    ])
    expect(data.daily).toEqual([
      { date: '2026-11-14', pageViews: 8, visits: 2 },
      { date: '2026-11-15', pageViews: 3, visits: 1 },
    ])
  })

  it('keeps at most ten pages and ten referrers', () => {
    const pages = Array.from({ length: 12 }, (_, index) => ({
      count: 100 - index,
      dimensions: { requestPath: `/page-${index}` },
    }))
    const referrers = Array.from({ length: 12 }, (_, index) => ({
      count: 100 - index,
      dimensions: { refererHost: `host-${index}.example` },
    }))
    const data = mapAnalyticsResponse(responseWith({ pages, referrers }), 30)
    expect(data.topPages).toHaveLength(10)
    expect(data.topReferrers).toHaveLength(10)
    expect(data.topPages[0]).toEqual({ path: '/page-0', views: 100 })
  })

  it('returns zeros when Cloudflare has no rows', () => {
    expect(mapAnalyticsResponse({ data: { viewer: { accounts: [{}] } } }, 7)).toEqual({
      daily: [],
      pageViews: 0,
      range: 7,
      topPages: [],
      topReferrers: [],
      visits: 0,
    })
  })
})

describe('Cloudflare request', () => {
  it('sends the token only in the authorization header', async () => {
    const apiToken = 'cf_analytics_super_secret'
    const fetchImpl = vi.fn().mockResolvedValue(
      Response.json(responseWith({ totals: [{ count: 1, sum: { visits: 1 } }] })),
    )

    await fetchCloudflareAnalytics({
      accountId: 'account-123',
      apiToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: new Date('2026-11-19T12:00:00.000Z'),
      range: 7,
      siteTag: 'site-abc',
    })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.cloudflare.com/client/v4/graphql')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${apiToken}`)
    expect(String(init.body)).not.toContain(apiToken)
  })

  it('reports a fixed error without leaking the token from Cloudflare text', async () => {
    const apiToken = 'cf_analytics_super_secret'
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(Response.json({ errors: [{ message: `bad token ${apiToken}` }] }))

    let caught: unknown
    try {
      await fetchCloudflareAnalytics({
        accountId: 'account-123',
        apiToken,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        range: 7,
        siteTag: 'site-abc',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AnalyticsError)
    expect(String(caught)).not.toContain(apiToken)
    expect((caught as Error).message).toBe(
      '[payload-cloudflare-analytics] Cloudflare analytics returned an error.',
    )
  })

  it('turns a network failure or non-2xx response into a fixed error', async () => {
    const token = 'cf_analytics_super_secret'
    const network = vi.fn().mockRejectedValue(new Error(`network failed for ${token}`))
    let caught: unknown
    try {
      await fetchCloudflareAnalytics({
        accountId: 'a',
        apiToken: token,
        fetchImpl: network as unknown as typeof fetch,
        range: 7,
        siteTag: 's',
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).toBe(
      '[payload-cloudflare-analytics] The Cloudflare analytics request failed.',
    )

    const http = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(
      fetchCloudflareAnalytics({
        accountId: 'a',
        apiToken: token,
        fetchImpl: http as unknown as typeof fetch,
        range: 7,
        siteTag: 's',
      }),
    ).rejects.toThrow('Cloudflare analytics returned HTTP 500.')
  })
})
