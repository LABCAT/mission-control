import { describe, expect, it } from 'vitest'

import type { CmsClient } from '../cms/client'
import {
  EMPLOYMENT_TYPES,
  jobDetailPath,
  jobDetailRoute,
  jobPageJsonLd,
  jobPageState,
  loadJobDetail,
  organisationPagePath,
  toJobDetail,
  type DetailJob,
} from './detail'
import { tenantJobPageSettings } from '../tenant/job-page-settings'
import type { SiteTenant } from '../tenant/types'

const NOW = new Date('2026-11-20T00:00:00.000Z')

const settings = (overrides: Parameters<typeof tenantJobPageSettings>[0] = {}) =>
  tenantJobPageSettings({ expiredJobGoneAfterMonths: 12, expiredJobMode: 'notice', ...overrides })

const tenant: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const published: DetailJob = {
  categories: [{ id: 1, name: 'Hospitality', slug: 'hospitality' }],
  companyName: 'Santo Bakery',
  description: { root: { children: [] } },
  displayedSalary: 'Vt 150,000 a month',
  expiresAt: '2026-12-01T00:00:00.000Z',
  id: 7,
  jobDescriptionPdf: { filename: 'chef.pdf', url: 'https://cdn.example/chef.pdf' },
  jobType: { id: 20, name: 'Full time', slug: 'full-time' },
  location: [{ id: 12, name: 'Port Vila', slug: 'port-vila' }],
  locationDetails: 'Waterfront',
  organisation: { approved: true, id: 201, name: 'Santo Bakery', pageEnabled: true, slug: 'santo-bakery' },
  publishedAt: '2026-11-01T00:00:00.000Z',
  salaryBand: { id: 3, name: 'Vt 100k–200k' },
  slug: 'head-chef',
  status: 'published',
  title: 'Head Chef',
}

describe('job page paths @S-280', () => {
  it('builds and reads the slug of a job page', () => {
    expect(jobDetailPath('head chef')).toBe('/jobs/head%20chef')
    expect(jobDetailRoute('/jobs/head-chef')).toBe('head-chef')
    expect(jobDetailRoute('/jobs/head-chef/')).toBe('head-chef')
    expect(jobDetailRoute('/jobs/Port%20Vila%2FChef')).toBe('Port Vila/Chef')
  })

  it('is not a job page for a listing, a section, or a broken escape', () => {
    for (const path of ['/jobs', '/jobs/', '/jobs/category/hospitality', '/jobs/a/b', '/', '/jobs/%E0%A4%A']) {
      expect(jobDetailRoute(path), path).toBeNull()
    }
  })
})

describe('job page state @S-282 @S-283', () => {
  it('keeps a published job with no expiry live', () => {
    expect(jobPageState({ now: NOW, settings: settings(), status: 'published' })).toBe('live')
  })

  it('is live until the closing instant', () => {
    expect(
      jobPageState({ expiresAt: '2026-11-21T00:00:00.000Z', now: NOW, settings: settings(), status: 'published' }),
    ).toBe('live')
    expect(
      jobPageState({ expiresAt: NOW.toISOString(), now: NOW, settings: settings(), status: 'published' }),
    ).toBe('expired')
  })

  it('shows the notice for a job expired less than a year ago', () => {
    expect(
      jobPageState({ expiresAt: '2026-06-01T00:00:00.000Z', now: NOW, settings: settings(), status: 'published' }),
    ).toBe('expired')
  })

  it('turns the page into 410 Gone twelve months past the expiry', () => {
    expect(
      jobPageState({ expiresAt: '2025-11-01T00:00:00.000Z', now: NOW, settings: settings(), status: 'published' }),
    ).toBe('gone')
    // A tenant can shorten the window, or keep the notice for ever with 0 months.
    expect(
      jobPageState({
        expiresAt: '2026-09-01T00:00:00.000Z',
        now: NOW,
        settings: settings({ expiredJobGoneAfterMonths: 2 }),
        status: 'published',
      }),
    ).toBe('gone')
    expect(
      jobPageState({
        expiresAt: '2020-01-01T00:00:00.000Z',
        now: NOW,
        settings: tenantJobPageSettings({ expiredJobGoneAfterMonths: 0, expiredJobMode: 'notice' }),
        status: 'published',
      }),
    ).toBe('expired')
  })

  it('answers 410 at once for a tenant on the legacy hide mode', () => {
    expect(
      jobPageState({
        expiresAt: '2026-11-19T00:00:00.000Z',
        now: NOW,
        settings: settings({ expiredJobMode: 'gone' }),
        status: 'published',
      }),
    ).toBe('gone')
  })

  it('treats the CMS `expired` status as a closed job, not a missing one', () => {
    // The CMS flips status to `expired` when a job closes; that is the state the page must show
    // the notice for, and the one a site key actually reads.
    const expiredStatus = (over: Parameters<typeof jobPageState>[0]) => jobPageState(over)
    expect(
      expiredStatus({ expiresAt: '2026-11-21T00:00:00.000Z', now: NOW, settings: settings(), status: 'expired' }),
    ).toBe('expired')
    // Closed early by an admin: still ahead of its date, but not live.
    expect(
      expiredStatus({ expiresAt: '2026-12-31T00:00:00.000Z', now: NOW, settings: settings(), status: 'expired' }),
    ).toBe('expired')
    expect(
      expiredStatus({ expiresAt: '2025-11-01T00:00:00.000Z', now: NOW, settings: settings(), status: 'expired' }),
    ).toBe('gone')
    expect(expiredStatus({ now: NOW, settings: settings(), status: 'expired' })).toBe('expired')
    expect(
      expiredStatus({ now: NOW, settings: settings({ expiredJobMode: 'gone' }), status: 'expired' }),
    ).toBe('gone')
  })

  it('is gone for a job that was never published', () => {
    for (const status of ['draft', 'pending', 'cancelled', null, undefined]) {
      expect(jobPageState({ now: NOW, settings: settings(), status }), String(status)).toBe('gone')
    }
  })
})

describe('tenant job page settings @S-288', () => {
  it('defaults to the documented behaviour: notice, twelve months, no public views', () => {
    expect(tenantJobPageSettings(undefined)).toEqual({
      expiredJobMode: 'notice',
      goneAfterMonths: 12,
      publicJobViews: false,
    })
    expect(tenantJobPageSettings({})).toEqual(tenantJobPageSettings(undefined))
  })

  it('reads a saved setting, and survives a nonsense one', () => {
    expect(
      tenantJobPageSettings({
        expiredJobGoneAfterMonths: 3,
        expiredJobMode: 'gone',
        publicJobViews: true,
      }),
    ).toEqual({ expiredJobMode: 'gone', goneAfterMonths: 3, publicJobViews: true })

    expect(tenantJobPageSettings({ expiredJobMode: 'hide' }).expiredJobMode).toBe('notice')
    expect(tenantJobPageSettings({ expiredJobGoneAfterMonths: -4 }).goneAfterMonths).toBe(12)
    expect(tenantJobPageSettings({ expiredJobGoneAfterMonths: 1.5 }).goneAfterMonths).toBe(12)
    expect(tenantJobPageSettings({ expiredJobGoneAfterMonths: 0 }).goneAfterMonths).toBeNull()
  })
})

describe('toJobDetail @S-280', () => {
  it('maps every field the page shows', () => {
    expect(toJobDetail(published, { descriptionHtml: '<p>Run the kitchen</p>' })).toEqual({
      categories: ['Hospitality'],
      categoryIds: [1],
      closes: '2026-12-01T00:00:00.000Z',
      descriptionHtml: '<p>Run the kitchen</p>',
      displayedSalary: 'Vt 150,000 a month',
      id: 7,
      jobType: 'Full time',
      location: 'Port Vila',
      locationDetails: 'Waterfront',
      organisation: { name: 'Santo Bakery', url: '/organisations/santo-bakery' },
      pdf: { filename: 'chef.pdf', url: 'https://cdn.example/chef.pdf' },
      postedAt: '2026-11-01T00:00:00.000Z',
      salaryBand: 'Vt 100k–200k',
      slug: 'head-chef',
      title: 'Head Chef',
      url: '/jobs/head-chef',
    })
  })

  it('shows the organisation name but no link unless its page is public', () => {
    const org = (overrides: Record<string, unknown>) =>
      toJobDetail({
        ...published,
        organisation: { id: 1, name: 'Private Co', slug: 'private-co', ...overrides },
      })!

    expect(org({}).organisation).toEqual({ name: 'Private Co' })
    expect(org({ approved: true }).organisation).toEqual({ name: 'Private Co' })
    expect(org({ pageEnabled: true }).organisation).toEqual({ name: 'Private Co' })
    expect(org({ approved: true, pageEnabled: true }).organisation).toEqual({
      name: 'Private Co',
      url: '/organisations/private-co',
    })
  })

  it('takes the company name when the job names no organisation', () => {
    const detail = toJobDetail({ ...published, organisation: null })

    expect(detail?.organisation).toEqual({ name: 'Santo Bakery' })
  })

  it('refuses a job with no slug or no attribution', () => {
    expect(toJobDetail({ ...published, slug: null })).toBeNull()
    expect(toJobDetail({ ...published, title: '  ' })).toBeNull()
    expect(toJobDetail({ ...published, companyName: null, organisation: null })).toBeNull()
  })

  it('joins several locations and leaves out empty refs', () => {
    const detail = toJobDetail({
      ...published,
      location: [null, { id: 1, name: 'Port Vila' }, { id: 2, name: 'Luganville' }],
    })

    expect(detail?.location).toBe('Port Vila, Luganville')
    expect(toJobDetail({ ...published, location: null })?.location).toBeUndefined()
  })

  it('drops a PDF with no url and a blank how-to-apply', () => {
    const detail = toJobDetail({ ...published, howToApply: '   ', jobDescriptionPdf: { filename: 'x.pdf' } })

    expect(detail?.pdf).toBeUndefined()
    expect(detail?.howToApply).toBeUndefined()
  })
})

describe('organisationPagePath @S-281', () => {
  it('exists only for an approved organisation with its page switched on', () => {
    expect(organisationPagePath({ approved: true, pageEnabled: true, slug: 'santo' })).toBe('/organisations/santo')
    expect(organisationPagePath({ approved: true, slug: 'santo' })).toBeNull()
    expect(organisationPagePath({ pageEnabled: true, slug: 'santo' })).toBeNull()
    expect(organisationPagePath({ approved: true, pageEnabled: true, slug: '  ' })).toBeNull()
  })
})

describe('JobPosting structured data @S-284', () => {
  const detail = toJobDetail(published, { descriptionHtml: '<p>Run <strong>the</strong> kitchen</p>' })!

  it('maps a live job, with the organisation and address a search engine needs', () => {
    const jsonLd = jobPageJsonLd({
      detail,
      jobTypeSlug: 'full-time',
      siteUrl: 'https://vanuatuwok.vu',
      tenant,
    })

    expect(jsonLd).toEqual({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-11-01T00:00:00.000Z',
      description: 'Run the kitchen',
      employmentType: 'FULL_TIME',
      hiringOrganization: {
        '@type': 'Organization',
        name: 'Santo Bakery',
        sameAs: 'https://vanuatuwok.vu/organisations/santo-bakery',
      },
      jobLocation: {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', addressLocality: 'Port Vila' },
      },
      title: 'Head Chef',
      validThrough: '2026-12-01T00:00:00.000Z',
    })
  })

  it('leaves out an employment type it does not know rather than guess', () => {
    expect(jobPageJsonLd({ detail, jobTypeSlug: 'seasonal', siteUrl: 'https://x.test', tenant })?.employmentType).toBeUndefined()
    expect(EMPLOYMENT_TYPES['full-time']).toBe('FULL_TIME')
  })

  it('carries no sameAs for an organisation with no public page', () => {
    const privateDetail = toJobDetail({
      ...published,
      organisation: { id: 1, name: 'Private Co', slug: 'private-co' },
    })!

    expect(
      jobPageJsonLd({ detail: privateDetail, siteUrl: 'https://x.test', tenant })?.hiringOrganization,
    ).toEqual({ '@type': 'Organization', name: 'Private Co' })
  })
})

const cmsWith = (docs: Record<string, Record<string, unknown>[]>, calls: unknown[] = []) => {
  const bySlug = (collection: string, slug: string) =>
    (docs[collection] ?? []).find((doc) => doc.slug === slug) ?? null

  const categoryFilter = (where: unknown): (number | string)[] | null => {
    const clauses = (where as { and?: Record<string, unknown>[] } | undefined)?.and ?? []
    const clause = clauses.find((item) => item.categories)

    return (clause?.categories as { in: (number | string)[] } | undefined)?.in ?? null
  }

  const find = async (collection: string, options: { where?: unknown } = {}) => {
    calls.push({ collection, options })
    const wanted = categoryFilter(options.where)
    const matching = (docs[collection] ?? []).filter(
      (doc) =>
        !wanted ||
        ((doc.categories as { id?: number | string }[] | undefined) ?? []).some((ref) =>
          wanted.includes(ref.id as number | string),
        ),
    )

    return {
      docs: matching,
      hasNextPage: false,
      hasPrevPage: false,
      limit: 10,
      page: 1,
      totalDocs: (docs[collection] ?? []).length,
      totalPages: 1,
    }
  }

  return {
    find,
    findBySlug: async (collection: string, slug: string) => bySlug(collection, slug),
  } as unknown as Pick<CmsClient, 'find' | 'findBySlug'>
}

describe('loadJobDetail @S-282 @S-283', () => {
  const live = { ...published }
  const expired = {
    ...published,
    expiresAt: '2026-06-01T00:00:00.000Z',
    id: 8,
    slug: 'closed-chef',
    title: 'Closed Chef',
  }
  const old = { ...published, expiresAt: '2024-01-01T00:00:00.000Z', id: 9, slug: 'ancient-chef' }
  const other = {
    ...published,
    id: 10,
    slug: 'baker',
    title: 'Baker',
    categories: [{ id: 1, name: 'Hospitality', slug: 'hospitality' }],
  }

  it('renders a live job with its structured data and no similar list', async () => {
    const result = await loadJobDetail({
      cms: cmsWith({ jobs: [live] }),
      now: NOW,
      slug: 'head-chef',
      tenant: { ...tenant, expiredJobGoneAfterMonths: 12, expiredJobMode: 'notice', publicJobViews: true },
    })

    expect(result).toMatchObject({ found: true, status: 'live' })
    if (!result.found || result.status === 'gone') throw new Error('expected a live page')
    expect(result.view.detail.title).toBe('Head Chef')
    expect(result.view.jsonLd?.['@type']).toBe('JobPosting')
    expect(result.view.showViews).toBe(true)
    expect(result.view.expired).toBe(false)
    expect(result.view.similar).toEqual([])
  })

  it('renders a closed job with the notice and similar live jobs, and no JobPosting', async () => {
    const calls: unknown[] = []
    const result = await loadJobDetail({
      cms: cmsWith({ jobs: [expired, live, other] }, calls),
      now: NOW,
      slug: 'closed-chef',
      tenant,
    })

    expect(result).toMatchObject({ found: true, status: 'expired' })
    if (!result.found || result.status === 'gone') throw new Error('expected an expired page')
    expect(result.view.expired).toBe(true)
    expect(result.view.jsonLd).toBeUndefined()
    expect(result.view.showViews).toBe(false)
    expect(result.view.similar.map((job) => job.title).sort()).toEqual(['Baker', 'Head Chef'])
    expect(calls.length).toBeGreaterThan(0)
  })

  it('queries similar jobs by category id, and ranks same-category jobs ahead of the newest @S-282', async () => {
    const calls: { options: { where?: unknown } }[] = []
    const unrelated = {
      ...published,
      categories: [{ id: 2, name: 'Retail', slug: 'retail' }],
      id: 11,
      slug: 'cashier',
      title: 'Cashier',
    }
    const cms = cmsWith({ jobs: [expired, unrelated, other] }, calls as unknown[])
    const result = await loadJobDetail({ cms, now: NOW, slug: 'closed-chef', tenant })

    if (!result.found || result.status === 'gone') throw new Error('expected an expired page')
    const categoryQuery = JSON.stringify(calls.map((call) => call.options.where))
    expect(categoryQuery).toContain('"in":[1]')
    expect(categoryQuery).not.toContain('Hospitality')
    expect(result.view.similar[0]?.title).toBe('Baker')
  })

  it('answers gone after the tenant’s window, and for a draft', async () => {
    const ages = await loadJobDetail({ cms: cmsWith({ jobs: [old] }), now: NOW, slug: 'ancient-chef', tenant })
    expect(ages).toEqual({ found: true, status: 'gone' })

    const draft = await loadJobDetail({
      cms: cmsWith({ jobs: [{ ...live, status: 'draft' }] }),
      now: NOW,
      slug: 'head-chef',
      tenant,
    })
    expect(draft).toEqual({ found: true, status: 'gone' })
  })

  it('is not found for a slug nobody has', async () => {
    expect(await loadJobDetail({ cms: cmsWith({ jobs: [] }), now: NOW, slug: 'nope', tenant })).toEqual({
      found: false,
    })
  })
})
