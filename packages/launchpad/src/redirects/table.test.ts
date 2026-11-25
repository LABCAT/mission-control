import { describe, expect, it } from 'vitest'

import { legacyTable, splitPath } from './table'

describe('splitPath', () => {
  it('splits a path from its query and drops the trailing slash', () => {
    expect(splitPath('/jobs/page/2/')).toEqual(['/jobs/page/2', ''])
    expect(splitPath('/jobs?page=2')).toEqual(['/jobs', '?page=2'])
    expect(splitPath('/')).toEqual(['/', ''])
    expect(splitPath('/?p=3983')).toEqual(['/', '?p=3983'])
  })

  it('keeps a query that carries no path', () => {
    expect(splitPath('/feed/?rss_featured=1&rss_job_cat=98')).toEqual(['/feed', '?rss_featured=1&rss_job_cat=98'])
  })
})

describe('legacyTable', () => {
  const table = legacyTable([
    '/job-category/education/',
    '/job-type/contract/',
    '/resumes/',
    '/land-law-reforms/',
    '/jobs/executive-chef-16/',
    '/jobs/page/2/',
  ])

  it('puts a redirect, a 410 and a live route in their own buckets', () => {
    expect(table.redirects).toEqual({
      '/job-category/education/': '/jobs/education',
      '/job-type/contract/': '/jobs/contract',
      '/jobs/page/2/': '/jobs?page=2',
    })
    expect(table.gone).toEqual(['/land-law-reforms/', '/resumes/'])
    expect(table.routes).toEqual(['/jobs/executive-chef-16/'])
  })

  it('sorts every bucket, so a checked-in table has a stable diff', () => {
    const unsorted = legacyTable(['/job-type/contract/', '/job-category/education/', '/resumes/', '/blog/', '/feed/'])

    expect(Object.keys(unsorted.redirects)).toEqual(['/blog/', '/feed/', '/job-category/education/', '/job-type/contract/'])
    expect(unsorted.gone).toEqual(['/resumes/'])
  })

  it('answers a shortlink from the site table', () => {
    expect(legacyTable(['/?p=3983'], { shortlinks: new Map([[3983, '/about']]) }).redirects).toEqual({
      '/?p=3983': '/about',
    })
  })

  it('answers the same path the same way whether or not it has a trailing slash', () => {
    const withSlash = legacyTable(['/about-us/']).redirects
    const withoutSlash = legacyTable(['/about-us']).redirects

    expect(Object.values(withSlash)).toEqual(Object.values(withoutSlash))
    expect(Object.values(withSlash)).toEqual(['/about'])
  })
})
