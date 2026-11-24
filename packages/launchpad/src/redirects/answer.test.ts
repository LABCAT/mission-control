import { describe, expect, it } from 'vitest'

import { answerLegacy } from './answer'

const get = (url: string, method = 'GET'): Request => new Request(url, { method })

describe('answerLegacy @S-359', () => {
  it('answers a legacy path with a 301 and a Location header @S-359', async () => {
    const answer = answerLegacy(get('https://vanuatuwok.vu/job-category/education/'))

    expect(answer).not.toBeNull()
    const response = (answer as { response: Response }).response
    expect(response.status).toBe(301)
    expect(response.headers.get('location')).toBe('/jobs/education')
  })

  it('carries the query string into the target @S-356', () => {
    const answer = answerLegacy(get('https://vanuatuwok.vu/jobs/?s=chef&location=Port+Vila'))
    const response = (answer as { response: Response }).response

    expect(response.headers.get('location')).toBe('/jobs?q=chef&location=port-vila')
  })

  it('marks the redirect cacheable, since a 301 never changes @S-359', () => {
    const answer = answerLegacy(get('https://vanuatuwok.vu/about-us/'))
    const response = (answer as { response: Response }).response

    expect(response.headers.get('cache-control')).toContain('max-age=')
  })

  it('answers HEAD like GET, because a crawler checks a dead URL with HEAD @S-359', () => {
    const answer = answerLegacy(get('https://vanuatuwok.vu/employer/', 'HEAD'))

    expect((answer as { response: Response }).response.status).toBe(301)
  })

  it('reports a retired page as gone rather than answering it @S-353', () => {
    expect(answerLegacy(get('https://vanuatuwok.vu/resumes/'))).toEqual({ gone: true })
    expect(answerLegacy(get('https://vanuatuwok.vu/land-law-reforms/'))).toEqual({ gone: true })
    expect(answerLegacy(get('https://vanuatuwok.vu/resumes/', 'HEAD'))).toEqual({ gone: true })
  })

  it('leaves a path that is not legacy to the router @S-354', () => {
    expect(answerLegacy(get('https://vanuatuwok.vu/'))).toBeNull()
    expect(answerLegacy(get('https://vanuatuwok.vu/jobs/executive-chef-16/'))).toBeNull()
    expect(answerLegacy(get('https://vanuatuwok.vu/organisations/oxfam/'))).toBeNull()
  })

  it('does not redirect a POST, which is a form target and never a legacy page @S-358', () => {
    expect(answerLegacy(get('https://vanuatuwok.vu/job-category/education/', 'POST'))).toBeNull()
  })

  it('passes the site’s own table and shortlinks through @S-357', () => {
    const shortlinks = new Map([[42, '/about']])
    const answer = answerLegacy(get('https://vanuatuwok.vu/?p=42'), { shortlinks })

    expect((answer as { response: Response }).response.headers.get('location')).toBe('/about')
  })
})
