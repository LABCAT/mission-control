import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import BaseLayout from './BaseLayout.astro'
import FilterBar from './FilterBar.astro'
import JobCard from './JobCard.astro'
import JobDetailPage from './JobDetailPage.astro'
import JobsPage from './JobsPage.astro'
import OrgCard from './OrgCard.astro'
import Pagination from './Pagination.astro'
import Turnstile from './Turnstile.astro'
import { jobDetailView, toJobDetail, type DetailJob } from '../jobs/detail'
import { tenantJobPageSettings } from '../tenant/job-page-settings'
import { jobFilterDefinitions, jobListingView, type ListingFacets } from '../jobs/listing'
import type { FilterDefinition } from '../tenant/filters'
import type { SiteTenant } from '../tenant/types'
import type { JobSummary, OrgSummary } from '../types'

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

const job: JobSummary = {
  closes: '2026-12-01',
  id: 1,
  location: 'Port Vila',
  organisation: { name: 'Santo Bakery', url: '/organisations/santo-bakery' },
  salary: { amountMinor: 150000, currency: 'VUV', minorUnits: 0, period: 'month' },
  title: 'Head Chef',
  url: '/jobs/head-chef',
}

const org: OrgSummary = {
  jobCount: 3,
  location: 'Port Vila',
  name: 'Santo Bakery',
  url: '/organisations/santo-bakery',
}

const definitions: FilterDefinition[] = [
  { name: 'q' },
  { allowed: ['hospitality', 'trades'], name: 'category' },
  { name: 'page' },
]

describe('BaseLayout', () => {
  it('themes the document by mapping tenant branding onto Rocketship tokens only', async () => {
    const html = await container.renderToString(BaseLayout, {
      props: { path: '/jobs', siteUrl: 'https://vanuatuwok.vu', tenant, title: 'Jobs' },
      slots: { default: '<p>body</p>' },
    })

    expect(html).toContain('--rs-color-accent: #d0d0d0')
    expect(html).toContain('--rs-color-accent-hover: #b02a2a')
    expect(html).toContain('--rs-color-focus-ring: #dd3333')
    // The tenant's own colour names never reach the markup as classes or properties.
    expect(html).not.toContain('colorPrimary')
    expect(html).not.toContain('#06914b')
  })

  it('puts a hidden, personal-data-free view-as banner on every page @S-160', async () => {
    const render = (props: object) =>
      container.renderToString(BaseLayout, { props: { tenant, title: 'Any', ...props }, slots: { default: '' } })

    for (const html of [await render({ path: '/' }), await render({ noindex: true, path: '/account' })]) {
      // Hidden until the inline script sees the hint cookie, so cached HTML is the same for everyone.
      expect(html).toMatch(/<div class="lp-view-as[^"]*"[^>]*hidden/)
      expect(html).toContain('id="mc-view-as"')
      expect(html).toContain('impersonating=1')
      // Exit is a POST form, not a link.
      expect(html).toMatch(/<form action="\/account\/view-as\/exit" method="post"/)
      expect(html).toContain('Exit')
      // Nothing about any user is in the markup: the name arrives from /api/me after load.
      expect(html).toContain('a user')
    }
  })

  it('writes a canonical link, the language, and the title', async () => {
    const html = await container.renderToString(BaseLayout, {
      props: {
        description: 'Jobs in Vanuatu.',
        path: '/jobs',
        siteUrl: 'https://vanuatuwok.vu',
        tenant,
        title: 'Jobs | Vanuatu Wok',
      },
      slots: { default: '' },
    })

    expect(html).toContain('<link rel="canonical" href="https://vanuatuwok.vu/jobs/">')
    expect(html).toContain('<html lang="en"')
    expect(html).toContain('<title>Jobs | Vanuatu Wok</title>')
    expect(html).toContain('<meta name="description" content="Jobs in Vanuatu.">')
    expect(html).not.toContain('noindex')
  })

  it('keeps a noindex page out of search results and skips a missing description', async () => {
    const html = await container.renderToString(BaseLayout, {
      props: { noindex: true, path: '/jobs/search', tenant, title: 'Search' },
      slots: { default: '' },
    })

    expect(html).toContain('<meta name="robots" content="noindex, follow">')
    expect(html).not.toContain('<meta name="description"')
  })

  it('lets a page replace the canonical slot', async () => {
    const html = await container.renderToString(BaseLayout, {
      props: { path: '/jobs', siteUrl: 'https://example.test', tenant, title: 'Jobs' },
      slots: { canonical: '<link rel="canonical" href="https://example.test/jobs?x=1">', default: '' },
    })

    expect(html).toContain('href="https://example.test/jobs?x=1"')
    expect(html).not.toContain('href="https://example.test/jobs/"')
  })

  it('escapes structured data so it cannot close its own script element', async () => {
    const html = await container.renderToString(BaseLayout, {
      props: {
        jsonLd: { name: '</script><script>alert(1)</script>' },
        tenant,
        title: 'Jobs',
      },
      slots: { default: '' },
    })

    expect(html).toContain('application/ld+json')
    expect(html).not.toContain('<script>alert(1)</script>')
  })
})

describe('JobCard', () => {
  it('shows the tenant currency and timezone', async () => {
    const html = await container.renderToString(JobCard, {
      props: { job, locale: 'en', timezone: tenant.timezone ?? undefined },
    })

    expect(html).toContain('VUV')
    expect(html).toContain('150,000')
    expect(html).toContain('Dec 1, 2026')
    expect(html).toContain('href="/jobs/head-chef"')
    expect(html).toContain('rs-card')
  })

  it('shows a date-only closing date on its calendar day even west of UTC', async () => {
    const html = await container.renderToString(JobCard, {
      props: { job, locale: 'en', timezone: 'Pacific/Honolulu' },
    })

    expect(html).toContain('Dec 1, 2026')
    expect(html).not.toContain('Nov 30, 2026')
  })

  it('omits the salary and closing date rows when the job has neither', async () => {
    const html = await container.renderToString(JobCard, {
      props: {
        job: { ...job, closes: undefined, salary: undefined },
        locale: 'en',
      },
    })

    expect(html).not.toContain('lp-job__facts')
    expect(html).not.toContain('Closes')
  })

  it('carries the job id and a reserved Viewed label that starts hidden', async () => {
    const html = await container.renderToString(JobCard, { props: { job } })

    expect(html).toContain('data-job-id="1"')
    expect(html).toMatch(/<li[^>]*data-viewed-label[^>]*aria-hidden="true"[^>]*>Viewed<\/li>/)
    expect(html).toContain('lp-job__viewed')
  })

  it('falls back to the url as the viewed-jobs id', async () => {
    const html = await container.renderToString(JobCard, {
      props: { job: { ...job, id: undefined } },
    })

    expect(html).toContain('data-job-id="/jobs/head-chef"')
  })
})

describe('JobCard salary', () => {
  it('shows the employer\'s own salary text when there is no structured salary', async () => {
    const html = await container.renderToString(JobCard, {
      props: { job: { ...job, displayedSalary: 'Vt 1,500 a day', salary: undefined } },
    })

    expect(html).toContain('Vt 1,500 a day')
  })

  it('prefers the structured salary, with its period, over the free text', async () => {
    const html = await container.renderToString(JobCard, {
      props: {
        job: {
          ...job,
          displayedSalary: 'Vt 1,500 a day',
          salary: { amountMinor: 150000, currency: 'VUV', minorUnits: 0, period: 'month' },
        },
      },
    })

    // `Intl` separates the currency and the amount with a narrow no-break space.
    expect(html).toMatch(/VUV\s150,000 \/ month/)
    expect(html).not.toContain('Vt 1,500 a day')
  })
})

describe('OrgCard', () => {
  it('links the organisation and pluralises nothing but the count', async () => {
    const html = await container.renderToString(OrgCard, { props: { org, jobsLabel: 'open jobs' } })

    expect(html).toContain('href="/organisations/santo-bakery"')
    expect(html).toContain('3')
    expect(html).toContain('open jobs')
  })
})

describe('FilterBar', () => {
  it('is a GET form so it works without JavaScript', async () => {
    const html = await container.renderToString(FilterBar, {
      props: {
        action: '/jobs',
        controls: [
          { label: 'Keywords', name: 'q', type: 'search' },
          {
            anyLabel: 'All categories',
            label: 'Category',
            name: 'category',
            options: [{ label: 'Hospitality', value: 'hospitality' }],
            type: 'select',
          },
        ],
        definitions,
        values: { category: 'hospitality', page: '2', q: 'chef' },
      },
    })

    expect(html).toContain('method="get"')
    expect(html).toContain('action="/jobs"')
    expect(html).toContain('value="chef"')
    expect(html).toMatch(/<option[^>]*value="hospitality"[^>]*selected/)
    expect(html).toContain('All categories')
  })

  it('carries filters the bar has no control for, and drops the page number', async () => {
    const html = await container.renderToString(FilterBar, {
      props: {
        action: '/jobs',
        controls: [{ label: 'Keywords', name: 'q', type: 'search' }],
        definitions,
        values: { category: 'hospitality', page: '2', q: 'chef' },
      },
    })

    expect(html).toMatch(/<input[^>]*type="hidden"[^>]*name="category"[^>]*value="hospitality"/)
    expect(html).not.toContain('name="page"')
  })

  it('refuses a filter value the definition does not allow', async () => {
    const html = await container.renderToString(FilterBar, {
      props: {
        action: '/jobs',
        controls: [{ label: 'Keywords', name: 'q', type: 'search' }],
        definitions,
        values: { category: 'injected' },
      },
    })

    expect(html).not.toContain('value="injected"')
  })

  it('turns voluntary on with a checkbox that sends nothing when unticked', async () => {
    const html = await container.renderToString(FilterBar, {
      props: {
        action: '/jobs',
        controls: [{ label: 'Include voluntary jobs', name: 'voluntary', type: 'checkbox', value: '1' }],
        definitions: [...definitions, { allowed: ['1'], name: 'voluntary' }],
        values: { voluntary: '1' },
      },
    })

    expect(html).toMatch(/<input[^>]*name="voluntary"/)
    expect(html).toMatch(/<input[^>]*name="voluntary"[^>]*value="1"/)
    expect(html).toMatch(/<input[^>]*type="checkbox"/)
    expect(html).toContain(' checked')
    // Off is the absence of the parameter, so an unticked box must not post `voluntary=`.
    expect(html).not.toContain('name="voluntary" value=""')
  })

  it('leaves the voluntary box unticked when the filter is off, which is the default', async () => {
    const html = await container.renderToString(FilterBar, {
      props: {
        action: '/jobs',
        controls: [{ label: 'Include voluntary jobs', name: 'voluntary', type: 'checkbox', value: '1' }],
        values: {},
      },
    })

    expect(html).toContain('name="voluntary"')
    expect(html).not.toContain('checked')
  })
})

describe('JobsPage', () => {
  const facets: ListingFacets = {
    categories: [{ id: 1, name: 'Hospitality', slug: 'hospitality' }],
    locations: [{ id: 10, name: 'Port Vila', parentID: null, slug: 'port-vila' }],
    types: [
      { id: 20, isVolunteer: false, name: 'Full time', slug: 'full-time' },
      { id: 22, isVolunteer: true, name: 'Voluntary', slug: 'voluntary' },
    ],
  }

  const listingView = (overrides: {
    filters?: Record<string, string>
    jobs?: JobSummary[]
    page?: number
    total?: number
  } = {}) =>
    jobListingView({
      basePath: '/jobs',
      definitions: jobFilterDefinitions(facets),
      facets,
      filters: overrides.filters ?? {},
      jobs: overrides.jobs ?? [job, { ...job, isVolunteer: true, title: 'Water Volunteer', url: '/jobs/water' }],
      page: overrides.page ?? 1,
      pageSize: 20,
      total: overrides.total ?? 2,
    })

  it('renders the heading, the summary, the cards and a GET filter form', async () => {
    const html = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs in Vanuatu', view: listingView() },
    })

    expect(html).toMatch(/<h1[^>]*>Jobs in Vanuatu<\/h1>/)
    expect(html).toContain('2 jobs')
    expect(html).toContain('Head Chef')
    expect(html).toContain('Water Volunteer')
    expect(html).toContain('href="/jobs/head-chef"')
    expect(html).toMatch(/<form[^>]*action="\/jobs"[^>]*method="get"/)
    expect(html).toContain('name="voluntary"')
    expect(html).toContain('All categories')
    expect(html).toContain('All types')
    expect(html).toContain('All locations')
  })

  it('keeps a filtered listing out of the index but leaves the bare listing indexable', async () => {
    const plain = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs', view: listingView() },
    })
    const filtered = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs', view: listingView({ filters: { q: 'chef' } }) },
    })

    expect(plain).not.toContain('noindex')
    expect(filtered).toContain('<meta name="robots" content="noindex, follow">')
    // Both canonicalise to the unfiltered page, which drops the query string.
    expect(filtered).toContain('<link rel="canonical" href="/jobs/">')
  })

  it('noindexes page 2, a variant of the listing rather than a page of its own', async () => {
    const html = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs', view: listingView({ page: 2, total: 40 }) },
    })

    expect(html).toContain('noindex')
    expect(html).toContain('rel="prev"')
  })

  it('does not treat the section in the path as a filter, so a section has no "clear" link', async () => {
    const section = jobListingView({
      basePath: '/jobs/category/hospitality',
      definitions: jobFilterDefinitions(facets),
      facets,
      filters: { category: 'hospitality' },
      jobs: [],
      lockedKeys: ['category'],
      page: 1,
      total: 0,
    })

    const html = await container.renderToString(JobsPage, {
      props: { path: '/jobs/category/hospitality', tenant, title: 'Hospitality jobs', view: section },
    })

    expect(html).toContain('No jobs are listed yet.')
    expect(html).not.toContain('Clear filters')
    // The section's own control still shows the section, and the form posts to /jobs.
    expect(html).toMatch(/<option[^>]*value="hospitality"[^>]*selected/)
    expect(html).toMatch(/<form[^>]*action="\/jobs"/)
  })

  it('tells "no jobs at all" apart from "nothing matched these filters"', async () => {
    const empty = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs', view: listingView({ jobs: [], total: 0 }) },
    })
    const noMatch = await container.renderToString(JobsPage, {
      props: { path: '/jobs', tenant, title: 'Jobs', view: listingView({ filters: { q: 'nothing' }, jobs: [], total: 0 }) },
    })

    expect(empty).toContain('No jobs are listed yet.')
    expect(noMatch).toContain('No jobs match these filters.')
    // The empty state is announced, not just drawn.
    expect(empty).toMatch(/role="status"/)
  })
})

describe('Pagination', () => {
  it('renders nothing for a single page', async () => {
    const html = await container.renderToString(Pagination, {
      props: { href: (page: number) => `/jobs?page=${page}`, page: 1, totalPages: 1 },
    })

    expect(html.trim()).toBe('')
  })

  it('marks the current page and links the neighbours, with rel attributes', async () => {
    const html = await container.renderToString(Pagination, {
      props: {
        href: (page: number) => (page === 1 ? '/jobs' : `/jobs?page=${page}`),
        page: 2,
        totalPages: 3,
      },
    })

    expect(html).toContain('aria-current="page"')
    expect(html).toContain('href="/jobs" rel="prev"')
    expect(html).toContain('href="/jobs?page=3" rel="next"')
    expect(html).toContain('aria-label="Pagination"')
  })

  it('disables the previous link on the first page', async () => {
    const html = await container.renderToString(Pagination, {
      props: { href: (page: number) => `/jobs?page=${page}`, page: 1, totalPages: 2 },
    })

    expect(html).toContain('aria-disabled="true"')
    expect(html).toContain('rel="next"')
  })
})

describe('Turnstile', () => {
  it('hides the response field under the name the server reads', async () => {
    const html = await container.renderToString(Turnstile, {
      props: { action: 'apply', siteKey: '1x00000000000000000000AA' },
    })

    expect(html).toContain('name="cf-turnstile-response"')
    expect(html).toContain('data-turnstile-options')
    expect(html).toContain('&quot;sitekey&quot;:&quot;1x00000000000000000000AA&quot;')
    // One field only: the widget is told not to add its own with the same name.
    expect(html).toContain('&quot;response-field&quot;:false')
    expect(html.match(/name="cf-turnstile-response"/g)).toHaveLength(1)
  })

  it('shows the no-JavaScript fallback only when JavaScript is off', async () => {
    const html = await container.renderToString(Turnstile, {
      props: { action: 'apply', siteKey: '1x00000000000000000000AA' },
    })

    // A noscript element, so a visitor with JavaScript never sees the warning.
    expect(html).toContain('<noscript>')
    expect(html).toMatch(/<noscript>[\s\S]*needs JavaScript[\s\S]*<\/noscript>/)
  })
})

describe('JobDetailPage @S-280 @S-282 @S-285', () => {
  const doc: DetailJob = {
    description: { root: { children: [] } },
    expiresAt: '2026-12-01T00:00:00.000Z',
    howToApply: 'Email us.',
    id: 7,
    organisation: { approved: true, id: 3, name: 'Santo Bakery', pageEnabled: false, slug: 'santo-bakery' },
    slug: 'head-chef',
    status: 'published',
    title: 'Head Chef',
  }

  const render = (status: 'expired' | 'live', source: Parameters<typeof tenantJobPageSettings>[0] = {}) => {
    const detail = toJobDetail(doc, {})!
    const view = jobDetailView({
      detail,
      settings: tenantJobPageSettings(source),
      status,
      tenant,
    })

    return container.renderToString(JobDetailPage, {
      props: {
        applyHref: '/jobs/head-chef/apply',
        image: 'https://vanuatuwok.vu/og/jobs/head-chef.png',
        siteUrl: 'https://vanuatuwok.vu',
        view,
        viewEndpoint: '/api/jobs/7/view',
      },
    })
  }

  it('is indexable, carries JobPosting and the share tags, and has an apply button when live', async () => {
    const html = await render('live')

    expect(html).not.toContain('noindex')
    expect(html).toContain('"@type":"JobPosting"')
    expect(html).toContain('<meta property="og:image" content="https://vanuatuwok.vu/og/jobs/head-chef.png">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('href="/jobs/head-chef/apply"')
  })

  it('counts a live view even when the tenant does not show the number, and shows no number then', async () => {
    const hidden = await render('live', { publicJobViews: false })
    expect(hidden).toMatch(/<p[^>]*data-job-views[^>]*data-view-endpoint="\/api\/jobs\/7\/view"[^>]*hidden/)
    expect(hidden).not.toContain('data-job-views-count')

    const shown = await render('live', { publicJobViews: true })
    expect(shown).toContain('data-job-views-count')
  })

  it('shows the closed notice, noindex, no JobPosting, no apply button and no beacon when expired', async () => {
    const html = await render('expired')

    expect(html).toContain('No longer accepting applications')
    expect(html).toContain('noindex')
    expect(html).not.toContain('JobPosting')
    expect(html).not.toContain('/jobs/head-chef/apply')
    expect(html).not.toMatch(/<p[^>]*data-job-views/)
  })
})
