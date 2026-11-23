import { describe, expect, it, vi } from 'vitest'

import { siteHealth } from './health'

describe('site /health @S-243', () => {
  it('is 200 and uncacheable when the CMS answers', async () => {
    const fetcher = vi.fn(async (_url: URL, _init?: RequestInit) => new Response('{}', { status: 200 }))
    const response = await siteHealth({ CMS_URL: 'https://cms.example.test' }, fetcher as unknown as typeof fetch)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://cms.example.test/health')
  })

  it('is 503 when the CMS reports its database down', async () => {
    const fetcher = async () => new Response('{}', { status: 503 })
    const response = await siteHealth({ CMS_URL: 'https://cms.example.test' }, fetcher as unknown as typeof fetch)

    expect(response.status).toBe(503)
  })

  it('checks only the Worker when no CMS is configured', async () => {
    const fetcher = vi.fn()
    const response = await siteHealth({}, fetcher as unknown as typeof fetch)

    expect(response.status).toBe(200)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
