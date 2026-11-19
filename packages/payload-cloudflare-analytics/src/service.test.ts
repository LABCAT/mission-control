import type { PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_CACHE_TTL_MS } from './constants'
import { createCloudflareAnalyticsService, type CloudflareAnalyticsOptions } from './service'

const token = 'cf_analytics_super_secret'
const req = {} as PayloadRequest

const responseBody = {
  data: {
    viewer: {
      accounts: [
        {
          daily: [{ count: 2, dimensions: { date: '2026-11-19' }, sum: { visits: 1 } }],
          pages: [{ count: 2, dimensions: { requestPath: '/jobs' } }],
          referrers: [{ count: 1, dimensions: { refererHost: 'news.example.com' } }],
          totals: [{ count: 2, sum: { visits: 1 } }],
        },
      ],
    },
  },
}

const createService = (
  overrides: Partial<CloudflareAnalyticsOptions> = {},
  clock = { now: new Date('2026-11-19T12:00:00.000Z') },
) =>
  createCloudflareAnalyticsService({
    accountIdEnv: 'CF_ACCOUNT',
    apiTokenEnv: 'CF_TOKEN',
    environment: { CF_ACCOUNT: 'account-123', CF_TOKEN: token },
    now: () => clock.now,
    resolveSiteTag: () => 'site-abc',
    ...overrides,
  })

describe('caching', () => {
  it('serves the same account/site/range from memory for an hour, then refetches', async () => {
    const clock = { now: new Date('2026-11-19T12:00:00.000Z') }
    const fetchImpl = vi.fn(async () => Response.json(responseBody))
    const service = createService({ fetch: fetchImpl as unknown as typeof fetch }, clock)

    const first = await service.load({ range: 7, req })
    const second = await service.load({ range: 7, req })
    expect(first).toEqual(second)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    clock.now = new Date(clock.now.getTime() + DEFAULT_CACHE_TTL_MS + 1000)
    await service.load({ range: 7, req })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('keeps 7 and 30 day results apart', async () => {
    const fetchImpl = vi.fn(async () => Response.json(responseBody))
    const service = createService({ fetch: fetchImpl as unknown as typeof fetch })

    await service.load({ range: 7, req })
    await service.load({ range: 30, req })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not call Cloudflare without a site tag or credentials', async () => {
    const fetchImpl = vi.fn(async () => Response.json(responseBody))
    const fetch = fetchImpl as unknown as typeof globalThis.fetch

    const noTag = createService({ fetch, resolveSiteTag: () => undefined })
    await expect(noTag.load({ range: 7, req })).resolves.toEqual({ configured: false })

    const noCredentials = createService({ environment: {}, fetch })
    await expect(noCredentials.load({ range: 7, req })).resolves.toEqual({ configured: false })

    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
