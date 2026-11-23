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

    // The only script is the view-as banner's inline snippet (PJ-119), which renders nothing
    // unless the hint cookie is set, so the cached HTML stays the same for every visitor.
    const scripts = html.match(/<script[^>]*>/g) ?? []
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).not.toContain('src=')
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
