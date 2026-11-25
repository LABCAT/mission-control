import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import FeatureBoxes from '@mission-control/rocketship-payload/astro/feature-boxes'
import Hero from '@mission-control/rocketship-payload/astro/hero'
import RichText from '@mission-control/rocketship-payload/astro/rich-text'

import PageView from './PageView.astro'
import type { MenuView } from '../pages/menus'
import type { PageView as PageViewData } from '../pages/view'
import type { SiteTenant } from '../tenant/types'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

const tenant: SiteTenant = {
  branding: { colorAccent: '#dd3333', colorHover: '#b02a2a', colorPrimary: '#d0d0d0' },
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const menus: MenuView[] = [
  {
    label: 'Top bar',
    links: [{ href: '/contact', label: 'Contact us', newTab: false }],
    location: 'top',
  },
  {
    label: 'Main',
    links: [
      { href: '/jobs', label: 'Jobs', newTab: false },
      { href: '/about', label: 'About us', newTab: false },
    ],
    location: 'primary',
  },
  {
    label: 'Footer',
    links: [{ href: 'https://ycv.vu', label: 'YCV', newTab: true }],
    location: 'footer',
  },
]

const view: PageViewData = {
  latestJobs: {
    jobs: [
      {
        id: 1,
        organisation: { name: 'Santo Bakery', url: '/organisations/santo-bakery' },
        title: 'Head Chef',
        url: '/jobs/head-chef',
      },
    ],
    truncated: false,
  },
  metadata: { description: 'Find a job in Vanuatu.', noindex: false, title: 'Home | Vanuatu Wok' },
  page: { id: 1, role: 'home', title: 'Home' },
  path: '/',
  segments: [
    {
      blocks: [{ blockType: 'hero', body: 'Jobs across the islands.', heading: 'FIND A JOB IN VANUATU' }],
      kind: 'blocks',
    },
    { block: { blockType: 'latest-jobs', heading: 'Latest jobs' }, kind: 'latest-jobs' },
  ],
  trail: [{ name: 'Home', page: { id: 1, role: 'home', title: 'Home' }, path: '/' }],
}

const components = { hero: Hero, 'feature-boxes': FeatureBoxes, 'rich-text': RichText }

describe('PageView', () => {
  it('renders the blocks in the editor order with the latest jobs where the layout puts it @S-293', async () => {
    const html = await container.renderToString(PageView, {
      props: { allJobsHref: '/jobs', components, menus, siteUrl: 'https://vanuatuwok.vu', tenant, view },
    })

    expect(html).toContain('FIND A JOB IN VANUATU')
    expect(html).toContain('Jobs across the islands.')
    expect(html).toContain('Latest jobs')
    expect(html).toContain('Head Chef')
    // The block sits after the hero, not before it.
    expect(html.indexOf('FIND A JOB IN VANUATU')).toBeLessThan(html.indexOf('Head Chef'))
  })

  it('renders the site menus in the header and footer @S-295', async () => {
    const html = await container.renderToString(PageView, {
      props: { components, menus, tenant, view },
    })

    expect(html).toContain('aria-label="Main"')
    expect(html).toContain('aria-label="Top bar"')
    expect(html).toContain('aria-label="Footer"')
    expect(html).toContain('href="/about"')
    expect(html).toContain('href="https://ycv.vu"')
    expect(html).toContain('rel="noopener"')
  })

  it('ships no hydrated JavaScript, so a public page stays cacheable @S-296', async () => {
    const html = await container.renderToString(PageView, {
      props: { components, menus, tenant, view },
    })

    // No island, and no module script: nothing here is fetched, parsed or hydrated.
    expect(html).not.toContain('astro-island')
    expect(html).not.toContain('type="module"')

    // Two inline scripts, neither fetched: the view-as banner's snippet (PJ-119), which renders
    // nothing unless the hint cookie is set, and the page's JSON-LD (PJ-104).
    const scripts = html.match(/<script[^>]*>/g) ?? []
    // Banner (PJ-119), signed-in link swap (PJ-109) and structured data (PJ-104): inline snippets, no file.
    expect(scripts).toHaveLength(3)
    expect(scripts.every((script) => !script.includes('src='))).toBe(true)
    expect(scripts.filter((script) => script.includes('application/ld+json'))).toHaveLength(1)
  })

  it('keeps the page out of the index when its SEO says so @S-292', async () => {
    const html = await container.renderToString(PageView, {
      props: { components, menus, tenant, view: { ...view, metadata: { ...view.metadata, noindex: true } } },
    })

    expect(html).toContain('name="robots" content="noindex, follow"')
  })

  it('shows the block empty state when the site has no jobs yet @S-294', async () => {
    const html = await container.renderToString(PageView, {
      props: {
        components,
        menus,
        tenant,
        view: { ...view, latestJobs: { jobs: [], truncated: false } },
      },
    })

    expect(html).toContain('No jobs are listed yet.')
  })
})

describe('PageView head slot', () => {
  it('passes a head slot through to the document head @S-292', async () => {
    const html = await container.renderToString(PageView, {
      props: { components, menus, tenant, view },
      slots: { head: '<link href="/brand/icon-32.png" rel="icon" sizes="32x32" type="image/png" />' },
    })

    expect(html).toContain('href="/brand/icon-32.png" rel="icon"')
    expect(html.indexOf('rel="icon"')).toBeLessThan(html.indexOf('</head>'))
  })
})

describe('organisation directory block (PJ-38)', () => {
  const directoryView: PageViewData = {
    ...view,
    directory: {
      entries: [
        {
          initials: 'SB',
          jobCount: 2,
          logo: { height: 80, url: 'https://cdn/logo.png', width: 160 },
          name: 'Santo Bakery',
          typeLabel: 'Business',
          url: '/organisations/santo-bakery',
        },
        { initials: 'ET', jobCount: 0, name: 'Efate Tours', url: '/organisations/efate-tours' },
      ],
      filters: { type: 'business' },
      truncated: false,
    },
    path: '/organisations',
    segments: [
      { block: { blockType: 'organisation-directory', heading: 'Employers' }, kind: 'organisation-directory' },
    ],
  }

  const render = () =>
    container.renderToString(PageView, { props: { components, menus, tenant, view: directoryView } })

  it('lists the organisations with type and size filters, counts and links @S-223', async () => {
    const html = await render()

    expect(html).toContain('Employers')
    expect(html).toContain('href="/organisations/santo-bakery"')
    expect(html).toContain('2 open jobs')
    expect(html).toContain('name="type"')
    expect(html).toContain('name="size"')
    // A plain GET form back to the page: it works with JavaScript off.
    expect(html).toContain('action="/organisations"')
    expect(html).toContain('method="get"')
    // The active filter is kept selected.
    expect(html).toMatch(/<option value="business"[^>]* selected/)
  })

  it('lazy-loads logos with their size and falls back to initials @S-224', async () => {
    const html = await render()

    expect(html).toMatch(/<img[^>]*src="https:\/\/cdn\/logo\.png"[^>]*loading="lazy"/)
    expect(html).toMatch(/<img[^>]*width="160"[^>]*height="80"/)
    expect(html).toContain('>ET<')
  })

  it('ships no client JavaScript beyond the inline view-as snippet @S-224', async () => {
    const html = await render()

    expect(html).not.toContain('astro-island')
    expect(html).not.toContain('type="module"')
    // Only inline scripts: the view-as snippet and the page's JSON-LD (PJ-104).
    const scripts = html.match(/<script[^>]*>/g) ?? []
    // Two inline snippets, no file: the view-as banner (PJ-119) and the signed-in link swap (PJ-109).
    expect(scripts).toHaveLength(2)
    expect(scripts.every((script) => !script.includes('src='))).toBe(true)
  })

  it('hides a filter the block turns off and shows an empty state @S-223', async () => {
    const html = await container.renderToString(PageView, {
      props: {
        components,
        menus,
        tenant,
        view: {
          ...directoryView,
          directory: { entries: [], filters: {}, truncated: false },
          segments: [
            {
              block: { blockType: 'organisation-directory', emptyLabel: 'None yet', showSizeFilter: false },
              kind: 'organisation-directory',
            },
          ],
        },
      },
    })

    expect(html).toContain('None yet')
    expect(html).toContain('name="type"')
    expect(html).not.toContain('name="size"')
  })
})
