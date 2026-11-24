import { describe, expect, it } from 'vitest'

import { ogCardFor, ogImagePath, ogRoute } from './og-route'

const NOW = new Date('2026-11-23T00:00:00Z')
const ORIGIN = 'https://vanuatuwok.vu'

const job = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  jobType: { id: 20, name: 'Full time', slug: 'full-time' },
  location: [{ id: 11, name: 'Port Vila', slug: 'port-vila' }],
  organisation: { approved: true, id: 3, name: 'Acme Hospitality', pageEnabled: true, slug: 'acme' },
  slug: 'head-chef',
  status: 'published',
  title: 'Head Chef',
  ...overrides,
})

const cmsWith = (options: {
  job?: unknown
  organisation?: unknown
  pages?: unknown[]
  settings?: Record<string, unknown> | null
}) => {
  const pages = options.pages ?? [{ id: 1, role: 'home', slug: null, title: 'Home' }]

  return {
    findAll: async (collection: string) => (collection === 'pages' ? pages : []) as never,
    find: async () => ({ docs: [], totalDocs: 0 }) as never,
    findBySlug: async (collection: string) =>
      (collection === 'jobs' ? options.job ?? null : options.organisation ?? null) as never,
    global: async () => ({}) as never,
    tenantSettings: async () => (options.settings ?? null) as never,
  }
}

describe('share image route', () => {
  it('matches the three page kinds, and nothing else @S-259', () => {
    expect(ogRoute('/og/home.png')).toEqual({ kind: 'home' })
    expect(ogRoute('/og/jobs/head-chef.png')).toEqual({ kind: 'job', slug: 'head-chef' })
    expect(ogRoute('/og/jobs/head-chef.png/')).toEqual({ kind: 'job', slug: 'head-chef' })
    expect(ogRoute('/og/organisations/acme.png')).toEqual({ kind: 'organisation', slug: 'acme' })
    expect(ogRoute('/og/jobs/caf%C3%A9.png')).toEqual({ kind: 'job', slug: 'café' })

    for (const path of [
      '/og/jobs/head-chef',
      '/og/jobs/head-chef.jpg',
      '/og/home',
      '/og/jobs/a/b.png',
      '/og/',
      '/jobs/head-chef.png',
      '/',
    ]) {
      expect(ogRoute(path)).toBeNull()
    }
  })

  it('points each page at its own image @S-259', () => {
    expect(ogImagePath({ kind: 'home' })).toBe('/og/home.png')
    expect(ogImagePath({ kind: 'job', slug: 'head chef' })).toBe('/og/jobs/head%20chef.png')
    expect(ogImagePath({ kind: 'organisation', slug: 'acme' })).toBe('/og/organisations/acme.png')
  })

  it('builds a job card from the job page data, with the organisation logo @S-251', async () => {
    const result = await ogCardFor({
      cms: cmsWith({
        job: job({
          organisation: {
            approved: true,
            id: 3,
            logo: { url: 'https://cms/acme.png' },
            name: 'Acme Hospitality',
            pageEnabled: true,
            slug: 'acme',
          },
        }),
      }) as never,
      now: NOW,
      origin: ORIGIN,
      route: { kind: 'job', slug: 'head-chef' },
    })

    expect(result.kind).toBe('card')
    if (result.kind !== 'card') return
    expect(result.card).toMatchObject({
      facts: ['Port Vila', 'Full time'],
      kind: 'job',
      logo: { url: 'https://cms/acme.png' },
      subtitle: 'Acme Hospitality',
      title: 'Head Chef',
    })
    expect(result.key).toBe('jobs/head-chef')
  })

  it('is a 404 for a job the page would also refuse @S-259', async () => {
    // A closed job the tenant turns into a Gone page: its share image goes too.
    const gone = await ogCardFor({
      cms: cmsWith({
        job: job({ expiresAt: '2026-01-01T00:00:00Z', status: 'expired' }),
        settings: { expiredJobMode: 'gone', name: 'Vanuatu Wok', slug: 'vwok' },
      }) as never,
      now: NOW,
      origin: ORIGIN,
      route: { kind: 'job', slug: 'head-chef' },
    })
    expect(gone.kind).toBe('not-found')

    const missing = await ogCardFor({
      cms: cmsWith({ job: null }) as never,
      now: NOW,
      origin: ORIGIN,
      route: { kind: 'job', slug: 'nope' },
    })
    expect(missing.kind).toBe('not-found')

    // No CMS at all: a job page does not exist either.
    const noCms = await ogCardFor({ cms: null, now: NOW, route: { kind: 'job', slug: 'head-chef' } })
    expect(noCms.kind).toBe('not-found')
  })

  it('still draws a closed job the site keeps as a page @S-259', async () => {
    const result = await ogCardFor({
      cms: cmsWith({ job: job({ expiresAt: '2026-01-01T00:00:00Z', status: 'expired' }) }) as never,
      now: NOW,
      origin: ORIGIN,
      route: { kind: 'job', slug: 'head-chef' },
    })

    // The page answers 200 with a closed notice, so it is still shareable.
    expect(result.kind).toBe('card')
  })

  it('builds an organisation card from the profile @S-253', async () => {
    const result = await ogCardFor({
      cms: cmsWith({
        organisation: {
          logo: { url: 'https://cms/acme.png' },
          name: 'Acme Hospitality',
          size: '11-50',
          slug: 'acme',
          type: 'restaurant',
        },
        settings: { name: 'Vanuatu Wok', slug: 'vwok' },
      }) as never,
      origin: ORIGIN,
      route: { kind: 'organisation', slug: 'acme' },
    })

    expect(result.kind).toBe('card')
    if (result.kind !== 'card') return
    expect(result.card).toMatchObject({ kind: 'organisation', title: 'Acme Hospitality' })
    expect(result.key).toBe('organisations/acme')
  })

  it('is a 404 for an organisation the page would also refuse @S-259', async () => {
    const result = await ogCardFor({
      cms: cmsWith({ organisation: null }) as never,
      route: { kind: 'organisation', slug: 'private-co' },
    })
    expect(result.kind).toBe('not-found')
  })

  it('builds the home card from the home page, and without a CMS from the shell @S-254', async () => {
    const withCms = await ogCardFor({
      cms: cmsWith({
        pages: [
          {
            id: 1,
            role: 'home',
            seo: { description: 'Vacancies across Vanuatu.' },
            slug: null,
            title: 'Find a job',
          },
        ],
      }) as never,
      origin: ORIGIN,
      route: { kind: 'home' },
    })

    expect(withCms.kind).toBe('card')
    if (withCms.kind !== 'card') return
    expect(withCms.card).toMatchObject({
      kind: 'home',
      subtitle: 'Vacancies across Vanuatu.',
      title: 'Find a job | Vanuatu Wok',
    })

    const noCms = await ogCardFor({ cms: null, route: { kind: 'home' } })
    expect(noCms.kind).toBe('card')
    if (noCms.kind !== 'card') return
    expect(noCms.card).toMatchObject({ kind: 'home', siteName: 'Vanuatu Wok', title: 'Vanuatu Wok' })
  })
})
