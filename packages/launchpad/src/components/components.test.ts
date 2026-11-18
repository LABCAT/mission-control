import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import BaseLayout from './BaseLayout.astro'
import FilterBar from './FilterBar.astro'
import JobCard from './JobCard.astro'
import OrgCard from './OrgCard.astro'
import Pagination from './Pagination.astro'
import Turnstile from './Turnstile.astro'
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
    // The widget cannot work without JavaScript, so the fallback text says so.
    expect(html).toContain('needs JavaScript')
  })
})
