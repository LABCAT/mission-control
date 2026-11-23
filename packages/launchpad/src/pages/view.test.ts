import { describe, expect, it } from 'vitest'

import type { CmsClient } from '../cms/client'
import { loadSite, pageView } from './view'

const tenant = {
  branding: { colorAccent: '#dd3333', colorHover: '#0066bf', colorPrimary: '#06914b' },
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const pages = [
  { id: 1, role: 'home', title: 'Home', layout: [{ blockType: 'hero', heading: 'FIND A JOB IN VANUATU' }] },
  {
    id: 2,
    parent: 1,
    slug: 'about',
    title: 'About us',
    layout: [
      { blockType: 'hero', heading: 'About us' },
      { blockType: 'latest-jobs', heading: 'Latest jobs', limit: 3 },
    ],
  },
  { id: 3, parent: 2, slug: 'team', title: 'Our team', layout: [{ blockType: 'rich-text' }] },
]

const menus = [
  {
    id: 1,
    location: 'primary',
    name: 'Main',
    items: [
      { label: 'About us', linkType: 'page', page: 2 },
      { label: 'Team', linkType: 'page', page: 3 },
      { label: 'Jobs', linkType: 'custom', url: '/jobs' },
    ],
  },
]

const jobs = [
  {
    id: 7,
    organisation: { id: 1, name: 'YCV', slug: 'ycv' },
    placements: [],
    publishedAt: '2026-11-01T00:00:00.000Z',
    slug: 'cook',
    title: 'Cook',
  },
]

const cms = () => {
  const calls: { collection: string; options: Record<string, unknown> }[] = []
  const client = {
    findAll: async (collection: string, options: Record<string, unknown>) => {
      calls.push({ collection, options })
      return (collection === 'pages' ? pages : menus) as never
    },
    find: async (collection: string, options: Record<string, unknown>) => {
      calls.push({ collection, options })
      return { docs: jobs, totalDocs: jobs.length } as never
    },
  } as unknown as Pick<CmsClient, 'find' | 'findAll'>

  return { calls, client }
}

describe('loading a site', () => {
  it('renders the home page at / from its blocks @S-290', async () => {
    const { client } = cms()
    const content = await loadSite({ cms: client, pathname: '/', tenant })

    expect(content).toMatchObject({ kind: 'page', path: '/' })
    if (content.kind !== 'page') return
    const view = pageView(content, { tenant })

    expect(view.metadata.title).toBe('Home | Vanuatu Wok')
    expect(view.segments).toEqual([{ blocks: [{ blockType: 'hero', heading: 'FIND A JOB IN VANUATU' }], kind: 'blocks' }].map((segment) =>
      segment.kind === 'blocks'
        ? { blocks: [{ blockType: 'hero', heading: 'FIND A JOB IN VANUATU' }], kind: 'blocks' }
        : segment,
    ))
  })

  it('serves a nested page at /<parent>/<slug> @S-291', async () => {
    const { client } = cms()
    const content = await loadSite({ cms: client, pathname: '/about/team', tenant })

    expect(content).toMatchObject({ kind: 'page', path: '/about/team' })
    if (content.kind !== 'page') return
    expect(pageView(content, { tenant }).metadata.title).toBe('Our team | Vanuatu Wok')
  })

  it('answers not-found for an unknown path, with the menus still available @S-292', async () => {
    const { client } = cms()
    const content = await loadSite({ cms: client, pathname: '/no/such/page', tenant })

    expect(content.kind).toBe('not-found')
    expect(content.menus).toHaveLength(1)
  })

  it('loads the page and the menus once, and the jobs only when a block asks @S-293', async () => {
    const { calls, client } = cms()
    await loadSite({ cms: client, pathname: '/', tenant })
    expect(calls.map((call) => call.collection)).toEqual(['pages', 'menus'])

    calls.length = 0
    const about = await loadSite({ cms: client, pathname: '/about', tenant })
    expect(calls.map((call) => call.collection)).toEqual(['pages', 'menus', 'jobs'])
    expect(about).toMatchObject({ kind: 'page', latestJobs: { truncated: false } })
  })

  it('gives the template the latest jobs in the block order, and the menus by location @S-294', async () => {
    const { client } = cms()
    const content = await loadSite({ cms: client, pathname: '/about', tenant })
    if (content.kind !== 'page') throw new Error('expected a page')

    const view = pageView(content, { rssHref: '/jobs/rss.xml', tenant })

    expect(view.latestJobs?.jobs.map((job) => job.title)).toEqual(['Cook'])
    expect(view.latestJobs?.rssHref).toBe('/jobs/rss.xml')
    expect(view.segments.map((segment) => segment.kind)).toEqual(['blocks', 'latest-jobs'])
    expect(content.menus[0]?.location).toBe('primary')
  })

  it('gives the page metadata from its own SEO fields @S-292', async () => {
    const { client } = cms()
    const content = await loadSite({ cms: client, pathname: '/about/team', tenant })
    if (content.kind !== 'page') throw new Error('expected a page')

    const view = pageView(
      { ...content, page: { ...content.page, seo: { description: 'Who we are', noIndex: true, title: 'Team' } } },
      { tenant },
    )

    expect(view.metadata).toEqual({ description: 'Who we are', noindex: true, title: 'Team' })
  })
})

describe('a site with its own block slug', () => {
  it('loads the jobs for the block the site names @S-293', async () => {
    const pagesWithOwnSlug = pages.map((page) =>
      page.id === 2 ? { ...page, layout: [{ blockType: 'recent-jobs', limit: 3 }] } : page,
    )
    const calls: string[] = []
    const client = {
      findAll: async (collection: string) => (collection === 'pages' ? pagesWithOwnSlug : menus) as never,
      find: async (collection: string) => {
        calls.push(collection)
        return { docs: jobs, totalDocs: jobs.length } as never
      },
    } as unknown as Pick<CmsClient, 'find' | 'findAll'>

    const content = await loadSite({ cms: client, latestJobsSlug: 'recent-jobs', pathname: '/about', tenant })

    expect(calls).toEqual(['jobs'])
    expect(content).toMatchObject({ kind: 'page', latestJobs: { truncated: false } })
    if (content.kind !== 'page') return
    expect(content.segments).toEqual([{ block: { blockType: 'recent-jobs', limit: 3 }, kind: 'latest-jobs' }])
  })
})

describe('a site whose CMS renames the collections', () => {
  it('reads pages, menus and jobs by the slugs the plugin resolved @S-290', async () => {
    const calls: string[] = []
    const client = {
      findAll: async (collection: string) => {
        calls.push(collection)
        return (collection === 'content-pages' ? pages : menus) as never
      },
      find: async (collection: string) => {
        calls.push(collection)
        return { docs: jobs, totalDocs: jobs.length } as never
      },
    } as unknown as Pick<CmsClient, 'find' | 'findAll'>

    const content = await loadSite({
      cms: client,
      collections: { jobs: 'vacancies', menus: 'navigation', pages: 'content-pages' },
      pathname: '/about',
      tenant,
    })

    expect(content.kind).toBe('page')
    expect(calls.toSorted()).toEqual(['content-pages', 'navigation', 'vacancies'])
  })
})
