import { describe, expect, it } from 'vitest'

import type { JobDetailView } from '../jobs/detail'
import type { JobListingView } from '../jobs/listing'
import type { OrganisationProfile } from '../organisations/profile'
import type { PageView } from '../pages/view'
import type { SiteTenant } from '../tenant/types'
import {
  breadcrumbStructuredData,
  contentPageStructuredData,
  itemListStructuredData,
  jobStructuredData,
  jsonLdDocument,
  listingStructuredData,
  organizationNode,
  organisationStructuredData,
  pageType,
  webSiteStructuredData,
} from './structured-data'

const tenant: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const SITE = 'https://vanuatuwok.vu'

const pageView = (overrides: Partial<PageView> = {}, metadata: Partial<PageView['metadata']> = {}): PageView =>
  ({
    latestJobs: [],
    layout: [],
    metadata: { canonical: `${SITE}/about/`, noindex: false, title: 'About us', ...metadata },
    page: { id: 2, role: 'about', slug: 'about', title: 'About us' },
    path: '/about',
    segments: [],
    trail: [
      { name: 'Home', page: { id: 1, role: 'home', title: 'Home' }, path: '/' },
      { name: 'About us', page: { id: 2, role: 'about', slug: 'about', title: 'About us' }, path: '/about' },
    ],
    ...overrides,
  }) as PageView

const listingView = (overrides: Partial<JobListingView> = {}): JobListingView =>
  ({
    filters: [],
    hasActiveFilters: false,
    jobs: [
      { id: 1, title: 'Head Chef', url: '/jobs/head-chef' },
      { id: 2, title: 'Baker', url: '/jobs/baker' },
    ],
    page: 1,
    pageCount: 1,
    total: 2,
    ...overrides,
  }) as unknown as JobListingView

const jobView = (overrides: Partial<JobDetailView> = {}): JobDetailView =>
  ({
    detail: {
      categories: [],
      categoryIds: [],
      id: 7,
      organisation: { name: 'Santo Bakery', url: '/organisations/santo-bakery' },
      slug: 'head-chef',
      title: 'Head Chef',
      url: '/jobs/head-chef',
    },
    expired: false,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-11-01T00:00:00.000Z',
      hiringOrganization: { '@type': 'Organization', name: 'Santo Bakery' },
      title: 'Head Chef',
    },
    noindex: false,
    showViews: false,
    similar: [],
    status: 'live',
    tenant,
    title: 'Head Chef at Santo Bakery',
    ...overrides,
  }) as JobDetailView

const profile: OrganisationProfile = {
  about: 'Bread, daily.',
  initials: 'SB',
  jobs: [{ id: 1, title: 'Baker', url: '/jobs/baker' } as OrganisationProfile['jobs'][number]],
  location: 'Luganville',
  logo: { height: 64, url: 'https://cdn.example/santo.png', width: 64 },
  name: 'Santo Bakery',
  slug: 'santo-bakery',
  website: 'https://santobakery.example/',
}

describe('jsonLdDocument @S-340', () => {
  it('keeps one node’s own context', () => {
    expect(jsonLdDocument([{ '@context': 'https://schema.org', '@type': 'WebSite' }])).toEqual({
      '@context': 'https://schema.org',
      '@type': 'WebSite',
    })
  })

  it('folds several nodes into one graph with a single context', () => {
    expect(
      jsonLdDocument([
        { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Site' },
        { '@context': 'https://schema.org', '@type': 'Organization', name: 'Org' },
      ]),
    ).toEqual({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Site' },
        { '@type': 'Organization', name: 'Org' },
      ],
    })
  })
})

describe('webSiteStructuredData @S-340', () => {
  it('names the site and offers search over the listing', () => {
    expect(webSiteStructuredData({ name: ' Vanuatu Wok ', searchPath: '/jobs', siteUrl: SITE }))
      .toMatchSnapshot()
  })

  it('drops the search action when there is no origin to make a template from', () => {
    const node = webSiteStructuredData({ name: 'Vanuatu Wok', siteUrl: null })

    expect(node).not.toHaveProperty('potentialAction')
    expect(node).not.toHaveProperty('url')
  })

  it('ignores a blank name suffix and a blank search path', () => {
    const node = webSiteStructuredData({ description: '   ', name: 'Site', searchPath: '  ', siteUrl: SITE })

    expect(node).not.toHaveProperty('description')
    expect(node).not.toHaveProperty('potentialAction')
  })
})

describe('organizationNode @S-341', () => {
  it('carries the profile fields and absolute URLs it was given', () => {
    expect(
      organizationNode({
        description: ' Bread, daily. ',
        logo: ' https://cdn.example/santo.png ',
        name: 'Santo Bakery',
        sameAs: ['https://facebook.com/santo', '  ', null],
        url: 'https://santobakery.example/',
      }),
    ).toEqual({
      '@type': 'Organization',
      description: 'Bread, daily.',
      logo: 'https://cdn.example/santo.png',
      name: 'Santo Bakery',
      sameAs: ['https://facebook.com/santo'],
      url: 'https://santobakery.example/',
    })
  })

  it('leaves out empty optional fields rather than emitting blanks', () => {
    expect(organizationNode({ name: 'Santo Bakery', sameAs: [] })).toEqual({
      '@type': 'Organization',
      name: 'Santo Bakery',
    })
  })
})

describe('breadcrumbStructuredData @S-342', () => {
  it('numbers each crumb from one', () => {
    const node = breadcrumbStructuredData(
      [
        { name: 'Home', path: '/' },
        { name: 'Jobs', path: '/jobs' },
        { name: 'Head Chef', path: '/jobs/head-chef' },
      ],
      SITE,
    )

    expect(node).toMatchSnapshot()
  })

  it('refuses a single crumb, which is not a trail', () => {
    expect(breadcrumbStructuredData([{ name: 'Home', path: '/' }], SITE)).toBeNull()
  })

  it('refuses crumbs with no absolute URL to point at', () => {
    expect(
      breadcrumbStructuredData(
        [
          { name: 'Home', path: '/' },
          { name: 'Jobs', path: '/jobs' },
        ],
        null,
      ),
    ).toBeNull()
  })
})

describe('itemListStructuredData @S-343', () => {
  it('lists the items with positions and absolute URLs', () => {
    expect(
      itemListStructuredData({
        items: [
          { name: 'Head Chef', path: '/jobs/head-chef' },
          { name: 'Baker', path: '/jobs/baker' },
        ],
        name: 'Live jobs',
        path: '/jobs',
        siteUrl: SITE,
      }),
    ).toMatchSnapshot()
  })

  it('returns nothing for an empty list, which would advertise zero items', () => {
    expect(itemListStructuredData({ items: [], siteUrl: SITE })).toBeNull()
  })
})

describe('pageType @S-344', () => {
  it('gives a system page its more specific type', () => {
    expect(pageType('about')).toBe('AboutPage')
    expect(pageType('contact')).toBe('ContactPage')
    expect(pageType('organisations')).toBe('CollectionPage')
    expect(pageType('home')).toBe('WebPage')
    expect(pageType(null)).toBe('WebPage')
  })
})

describe('contentPageStructuredData @S-344', () => {
  it('describes an about page with the site and its trail', () => {
    expect(
      contentPageStructuredData({ siteUrl: SITE, tenant, trail: pageView().trail, view: pageView() }),
    ).toMatchSnapshot()
  })

  it('emits nothing for a page whose SEO tab says noindex', () => {
    const view = pageView({}, { noindex: true })

    expect(contentPageStructuredData({ siteUrl: SITE, tenant, trail: view.trail, view })).toBeNull()
  })

  it('keeps a page node but drops the trail when the site has no origin', () => {
    const view = pageView()
    const data = contentPageStructuredData({ siteUrl: null, tenant, trail: view.trail, view })
    const types = ((data?.['@graph'] ?? []) as { '@type': string }[]).map((node) => node['@type'])

    // The site and the page survive; a trail with no absolute URLs cannot.
    expect(types).toEqual(['WebSite', 'AboutPage'])
    expect(JSON.stringify(data)).not.toContain('BreadcrumbList')
  })

  it('gives a contact page the ContactPage type', () => {
    const view = pageView({
      page: { id: 3, role: 'contact', slug: 'contact', title: 'Contact' },
      path: '/contact',
    })

    expect(JSON.stringify(contentPageStructuredData({ siteUrl: SITE, tenant, trail: view.trail, view }))).toContain(
      '"@type":"ContactPage"',
    )
  })
})

describe('listingStructuredData @S-345', () => {
  it('describes the section as a CollectionPage of the jobs it shows', () => {
    expect(
      listingStructuredData({
        siteUrl: SITE,
        tenant,
        title: 'Jobs',
        trail: [
          { name: 'Home', path: '/' },
          { name: 'Jobs', path: '/jobs' },
        ],
        view: listingView(),
      }),
    ).toMatchSnapshot()
  })

  it('emits nothing for a filtered or paged variant, which is noindex', () => {
    const trail = [
      { name: 'Home', path: '/' },
      { name: 'Jobs', path: '/jobs' },
    ]

    expect(
      listingStructuredData({
        siteUrl: SITE,
        tenant,
        title: 'Jobs',
        trail,
        view: listingView({ hasActiveFilters: true }),
      }),
    ).toBeNull()
    expect(
      listingStructuredData({ siteUrl: SITE, tenant, title: 'Jobs', trail, view: listingView({ page: 2 }) }),
    ).toBeNull()
  })
})

describe('organisationStructuredData @S-346', () => {
  it('describes the organisation, its live jobs and the trail', () => {
    expect(organisationStructuredData({ profile, siteUrl: SITE, tenant })).toMatchSnapshot()
  })

  it('uses the organisation’s own site address when it has one', () => {
    const data = organisationStructuredData({ profile, siteUrl: SITE, tenant })
    if (!data) throw new Error('expected structured data')
    const organisation = (data['@graph'] as { '@type': string }[]).find(
      (node) => node['@type'] === 'Organization',
    )

    expect(organisation).toMatchObject({ url: 'https://santobakery.example/' })
  })

  it('leaves the job list out when the organisation has no live jobs', () => {
    const data = organisationStructuredData({ profile: { ...profile, jobs: [] }, siteUrl: SITE, tenant })
    if (!data) throw new Error('expected structured data')
    const types = (data['@graph'] as { '@type': string }[]).map((node) => node['@type'])

    expect(types).not.toContain('ItemList')
  })
})

describe('jobStructuredData @S-347', () => {
  it('keeps the posting and adds the trail', () => {
    expect(jobStructuredData({ siteUrl: SITE, view: jobView() })).toMatchSnapshot()
  })

  it('emits nothing for an expired job, which has no posting', () => {
    expect(jobStructuredData({ siteUrl: SITE, view: jobView({ jsonLd: undefined }) })).toBeNull()
  })

  it('emits nothing for a live job whose SEO tab says noindex', () => {
    expect(
      jobStructuredData({ siteUrl: SITE, view: jobView({ jsonLd: undefined, noindex: true }) }),
    ).toBeNull()
  })
})
