import { describe, expect, it } from 'vitest'

import { canonicalUrl, jobPostingStructuredData, seoMeta } from './seo'

describe('canonicalUrl', () => {
  it('normalises trailing slashes on the origin and the path', () => {
    expect(canonicalUrl('https://vanuatuwok.vu', '/jobs')).toBe('https://vanuatuwok.vu/jobs/')
    expect(canonicalUrl('https://vanuatuwok.vu/', '/jobs/')).toBe('https://vanuatuwok.vu/jobs/')
    expect(canonicalUrl('https://vanuatuwok.vu', '/')).toBe('https://vanuatuwok.vu/')
    expect(canonicalUrl('https://vanuatuwok.vu', '')).toBe('https://vanuatuwok.vu/')
    expect(canonicalUrl('https://vanuatuwok.vu', undefined)).toBe('https://vanuatuwok.vu/')
  })

  it('adds a leading slash and keeps nesting', () => {
    expect(canonicalUrl('https://vanuatuwok.vu', 'jobs/12/apply')).toBe(
      'https://vanuatuwok.vu/jobs/12/apply/',
    )
  })

  it('drops the query string so filters canonicalise to the unfiltered page', () => {
    expect(canonicalUrl('https://vanuatuwok.vu', '/jobs?category=trades&page=2')).toBe(
      'https://vanuatuwok.vu/jobs/',
    )
    expect(canonicalUrl('https://vanuatuwok.vu', '/jobs#top')).toBe('https://vanuatuwok.vu/jobs/')
  })

  it('works without a site URL, for a page rendered before the tenant is known', () => {
    expect(canonicalUrl(undefined, '/jobs')).toBe('/jobs/')
  })
})

describe('seoMeta', () => {
  it('trims the title and omits a blank description', () => {
    expect(seoMeta({ description: '   ', title: '  Jobs  ' })).toEqual({
      canonical: '/',
      description: undefined,
      noindex: false,
      title: 'Jobs',
    })
  })

  it('drops the description key entirely when empty so the meta tag is skipped', () => {
    expect('description' in seoMeta({ title: 'Jobs' })).toBe(false)
  })

  it('keeps a real description, trimmed', () => {
    expect(seoMeta({ description: ' Jobs in Vanuatu ', title: 'Jobs' }).description).toBe(
      'Jobs in Vanuatu',
    )
  })

  it('only sets noindex when asked, and defaults to indexable', () => {
    expect(seoMeta({ noindex: true, title: 'Search' }).noindex).toBe(true)
    expect(seoMeta({ title: 'Jobs' }).noindex).toBe(false)
  })
})

describe('jobPostingStructuredData', () => {
  it('omits every optional field the posting does not have', () => {
    expect(
      jobPostingStructuredData({ organisationName: 'Vanuatu Wok', title: 'Carpenter' }),
    ).toEqual({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      hiringOrganization: { '@type': 'Organization', name: 'Vanuatu Wok' },
      title: 'Carpenter',
    })
  })

  it('includes the location, dates and employment type when present', () => {
    const data = jobPostingStructuredData({
      countryCode: 'VU',
      datePosted: '2026-11-01',
      description: '<p>Build things</p>',
      employmentType: 'FULL_TIME',
      location: 'Port Vila',
      organisationName: 'Vanuatu Wok',
      organisationUrl: 'https://vanuatuwok.vu/organisations/vanuatu-wok',
      title: 'Carpenter',
      validThrough: '2026-12-01',
    })

    expect(data).toEqual({
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      datePosted: '2026-11-01',
      description: '<p>Build things</p>',
      employmentType: 'FULL_TIME',
      hiringOrganization: {
        '@type': 'Organization',
        name: 'Vanuatu Wok',
        sameAs: 'https://vanuatuwok.vu/organisations/vanuatu-wok',
      },
      jobLocation: {
        '@type': 'Place',
        address: {
          '@type': 'PostalAddress',
          addressCountry: 'VU',
          addressLocality: 'Port Vila',
        },
      },
      title: 'Carpenter',
      validThrough: '2026-12-01',
    })
  })
})
