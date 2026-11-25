import type { CacheLike } from '@mission-control/launchpad/cms'
import type { LlmsCms } from '@mission-control/launchpad/seo/llms-serve'
import { describe, expect, it, vi } from 'vitest'

import { siteLlms } from './llms'

const NOW = new Date('2026-06-01T00:00:00Z')
const SITE = 'https://vanuatuwok.vu'
const ENV = { CMS_URL: 'https://cms.example.com', SITE_KEY: 'sk_test' }

const docs: Record<string, unknown[]> = {
  jobs: [{ slug: 'head-chef', title: 'Head Chef' }],
  organisations: [{ name: 'Santo Bakery', slug: 'santo-bakery' }],
  pages: [
    { id: 1, role: 'home', slug: null, title: 'Home' },
    { id: 2, slug: 'about', title: 'About us' },
  ],
}

const fakeCms = (): LlmsCms => ({ findAll: vi.fn(async (collection: string) => docs[collection] ?? []) })

const memoryCache = (): CacheLike => {
  const store = new Map<string, Response>()

  return {
    match: async (request: Request) => store.get(request.url),
    put: async (request: Request, response: Response) => {
      store.set(request.url, response)
    },
  }
}

describe('siteLlms (PJ-104) @S-348', () => {
  it('serves the tenant’s summary and key URLs over the canonical origin', async () => {
    const response = await siteLlms({
      cache: memoryCache(),
      cms: fakeCms(),
      env: ENV,
      now: NOW,
      siteUrl: SITE,
    })
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(text).toContain('# Vanuatu Wok')
    expect(text).toContain(`- [Jobs](${SITE}/jobs)`)
    expect(text).toContain(`- [Head Chef](${SITE}/jobs/head-chef)`)
    expect(text).toContain(`- [Santo Bakery](${SITE}/organisations/santo-bakery)`)
    expect(text).toContain(`- [About us](${SITE}/about)`)
    // The home page is not a link: it is the origin the file already names.
    expect(text).not.toContain(`- [Home](${SITE}/)`)
  })

  it('answers 404 rather than a file of nothing when the CMS is not configured', async () => {
    for (const env of [{}, { CMS_URL: 'https://cms.example.com' }, { SITE_KEY: 'sk_test' }]) {
      const response = await siteLlms({ cms: fakeCms(), env, siteUrl: SITE })

      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('answers 404 without a canonical origin, since every link in the file is absolute', async () => {
    const response = await siteLlms({ cms: fakeCms(), env: ENV, siteUrl: null })

    expect(response.status).toBe(404)
  })
})
