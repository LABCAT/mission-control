import { describe, expect, it } from 'vitest'

import { jobRoute } from './job-route'

const day = 86_400_000
const now = new Date('2026-11-23T00:00:00Z')

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  organisation: { id: 3, name: 'Acme', slug: 'acme' },
  slug: 'welder',
  status: 'published',
  title: 'Welder',
  ...overrides,
})

const cmsWith = (doc: unknown, settings: Record<string, unknown> | null = {}) => ({
  find: async () => ({ docs: [], totalDocs: 0 }) as never,
  findBySlug: async () => doc as never,
  tenantSettings: async () => {
    if (settings === null) throw new Error('down')
    return settings as never
  },
})

describe('job route', () => {
  it('is a 404 with no CMS or an unknown slug @S-280', async () => {
    expect((await jobRoute({ cms: null, slug: 'welder' })).kind).toBe('not-found')
    expect((await jobRoute({ cms: cmsWith(null), now, slug: 'nope' })).kind).toBe('not-found')
  })

  it('renders a live job with JobPosting data @S-280 @S-284', async () => {
    const route = await jobRoute({
      cms: cmsWith(job({ expiresAt: new Date(now.getTime() + day).toISOString() })),
      now,
      slug: 'welder',
    })

    expect(route.kind).toBe('job')
    if (route.kind !== 'job') return
    expect(route.view.expired).toBe(false)
    expect(route.view.jsonLd).toBeDefined()
  })

  it('renders an expired job as 200 content without JobPosting @S-282', async () => {
    const route = await jobRoute({
      cms: cmsWith(job({ expiresAt: new Date(now.getTime() - day).toISOString(), status: 'expired' })),
      now,
      slug: 'welder',
    })

    expect(route.kind).toBe('job')
    if (route.kind !== 'job') return
    expect(route.view.expired).toBe(true)
    expect(route.view.jsonLd).toBeUndefined()
  })

  it('answers 410 once the tenant window has passed, using the window the CMS reports @S-283 @S-288', async () => {
    const expiresAt = new Date(now.getTime() - 100 * day).toISOString()
    const doc = job({ expiresAt, status: 'expired' })

    // Default window is 12 months: still a page. A 3-month tenant window: gone.
    expect((await jobRoute({ cms: cmsWith(doc), now, slug: 'welder' })).kind).toBe('job')
    expect(
      (await jobRoute({ cms: cmsWith(doc, { expiredJobGoneAfterMonths: 3 }), now, slug: 'welder' })).kind,
    ).toBe('gone')
  })

  it('falls back to the documented defaults when site settings cannot be read @S-288', async () => {
    const route = await jobRoute({
      cms: cmsWith(job({ expiresAt: new Date(now.getTime() + day).toISOString() }), null),
      now,
      slug: 'welder',
    })

    expect(route.kind).toBe('job')
  })
})
