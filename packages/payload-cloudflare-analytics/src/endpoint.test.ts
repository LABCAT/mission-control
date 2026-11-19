import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { createAnalyticsEndpoint } from './endpoint'
import { createCloudflareAnalyticsService, type CloudflareAnalyticsService } from './service'
import type { CloudflareAnalyticsData } from './types'

const token = 'cf_analytics_super_secret'

const data: CloudflareAnalyticsData = {
  daily: [],
  pageViews: 1,
  range: 7,
  topPages: [],
  topReferrers: [],
  visits: 1,
}

const makeRequest = ({
  collection = 'users',
  range = '7',
}: {
  collection?: null | string
  range?: string
} = {}) =>
  ({
    payload: { config: { admin: { user: 'users' } } },
    searchParams: new URLSearchParams(`range=${range}`),
    user: collection ? { collection, id: 1 } : null,
  }) as unknown as PayloadRequest

const stubService = () => {
  const load = vi.fn(async () => ({ configured: true as const, data }))
  return { load, service: { endpointPath: '/cloudflare-analytics', load } as unknown as CloudflareAnalyticsService }
}

describe('endpoint access control', () => {
  it('rejects anonymous requests before touching Cloudflare', async () => {
    const { load, service } = stubService()
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest({ collection: null }))

    expect(response.status).toBe(401)
    expect(load).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      error: 'You must be signed in to view analytics.',
    })
  })

  it('returns analytics for a signed-in admin user and passes the range through', async () => {
    const { load, service } = stubService()
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest({ collection: 'users', range: '30' }))

    expect(response.status).toBe(200)
    expect(load).toHaveBeenCalledWith({ range: 30, req: expect.anything() })
    await expect(response.json()).resolves.toEqual({ configured: true, data })
  })

  it('rejects a user from another auth collection without touching Cloudflare', async () => {
    const { load, service } = stubService()
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest({ collection: 'site-members' }))

    expect(response.status).toBe(403)
    expect(load).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toEqual({
      error: 'Admin access is required to view analytics.',
    })
  })

  it('falls back to 7 days for an unsupported range', async () => {
    const { load, service } = stubService()
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    await endpoint.handler(makeRequest({ range: '365' }))

    expect(load).toHaveBeenCalledWith({ range: 7, req: expect.anything() })
  })

  it('returns a friendly not-configured result with no site tag', async () => {
    const service = createCloudflareAnalyticsService({
      environment: { CF_ACCOUNT: 'account-123', CF_TOKEN: token },
      resolveSiteTag: () => undefined,
    })
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ configured: false })
  })
})

describe('endpoint error and secret handling', () => {
  it('handles an upstream failure without exposing the token or upstream text', async () => {
    const service = createCloudflareAnalyticsService({
      accountIdEnv: 'CF_ACCOUNT',
      apiTokenEnv: 'CF_TOKEN',
      environment: { CF_ACCOUNT: 'account-123', CF_TOKEN: token },
      fetch: vi
        .fn()
        .mockResolvedValue(
          Response.json({ errors: [{ message: `rejected ${token}` }] }),
        ) as unknown as typeof fetch,
      resolveSiteTag: () => 'site-abc',
    })
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest())
    const body = await response.text()

    expect(response.status).toBe(502)
    expect(body).toContain('Cloudflare analytics is unavailable right now.')
    expect(body).not.toContain(token)
  })

  it('never puts the token in a successful response', async () => {
    const service = createCloudflareAnalyticsService({
      accountIdEnv: 'CF_ACCOUNT',
      apiTokenEnv: 'CF_TOKEN',
      environment: { CF_ACCOUNT: 'account-123', CF_TOKEN: token },
      fetch: vi.fn().mockResolvedValue(
        Response.json({
          data: {
            viewer: {
              accounts: [{ totals: [{ count: 1, sum: { visits: 1 } }] }],
            },
          },
        }),
      ) as unknown as typeof fetch,
      resolveSiteTag: () => 'site-abc',
    })
    const endpoint = createAnalyticsEndpoint({ path: '/cloudflare-analytics', service })

    const response = await endpoint.handler(makeRequest())
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).toContain('"configured":true')
    expect(body).not.toContain(token)
  })
})
