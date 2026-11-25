import { describe, expect, it } from 'vitest'

import { FEED_JOBS, legacyRedirect, normaliseLegacyPath } from '@mission-control/launchpad/redirects'

import { VWOK_SHORTLINKS } from './legacy-shortlinks'
import { vwokLegacyAnswer } from './legacy-routes'

const answer = (path: string, method = 'GET'): ReturnType<typeof vwokLegacyAnswer> =>
  vwokLegacyAnswer(new Request(`https://vanuatuwok.vu${path}`, { method }))

const locationOf = (path: string): string | null => {
  const result = answer(path)
  if (!result || !('response' in result)) return null
  return result.response.headers.get('location')
}

describe('vwok shortlinks @S-357', () => {
  it('reads a Wordpress shortlink as the post’s new address @S-357', () => {
    expect(locationOf('/?p=655')).toBe('/contact')
    expect(locationOf('/?p=3983')).toBe('/about')
    expect(locationOf('/?p=23445')).toBe('/organisations')
    expect(locationOf('/?p=141704')).toBe('/jobs/executive-chef-16')
  })

  it('answers 410 for a shortlink to a page the site did not keep @S-357', () => {
    for (const id of [168, 791, 29143, 33579]) {
      expect(answer(`/?p=${id}`), `?p=${id}`).toEqual({ gone: true })
    }
  })

  it('answers 410 for an id nobody carried over @S-357', () => {
    // The CV profile in the crawl's table is deliberately absent: seeker personal data is not
    // imported (PJ-89).
    expect(answer('/?p=50000')).toEqual({ gone: true })
  })

  it('keeps every shortlink target off the legacy table, so there is no chain @S-359', () => {
    for (const [id, location] of VWOK_SHORTLINKS) {
      const { path } = normaliseLegacyPath(location)
      const followUp = legacyRedirect({ pathname: path })
      expect(followUp, `?p=${id} -> ${location}`).toBeNull()
    }
  })

  it('never points a shortlink at a retired page @S-353', () => {
    for (const [id, location] of VWOK_SHORTLINKS) {
      expect(/^\/(resumes|land-law-reforms|organisation-competition|no-resumes|job-email-text)\b/.test(location), `?p=${id} -> ${location}`).toBe(
        false,
      )
    }
  })
})

describe('vwok legacy answers @S-350', () => {
  it('answers the crawl’s job taxonomy URLs with a 301 @S-351', () => {
    expect(locationOf('/job-category/hospitality-tourism/')).toBe('/jobs/hospitality-tourism')
    expect(locationOf('/job-type/full-time/')).toBe('/jobs/full-time')
    expect(locationOf('/job-salary/not-stated/')).toBe('/jobs?salary=not-stated')
  })

  it('answers the crawl’s organisation URLs with a 301 @S-352', () => {
    expect(locationOf('/organisation/83-islands-distillery/')).toBe('/organisations/83-islands-distillery')
    expect(locationOf('/organisation/carpenter-motors-(vanuatu)-limited/')).toBe(
      '/organisations/carpenter-motors-vanuatu-limited',
    )
  })

  it('answers the CV module with 410 @S-353', () => {
    expect(answer('/resumes/')).toEqual({ gone: true })
    expect(answer('/resumes/page/2/')).toEqual({ gone: true })
  })

  it('answers the site feed with the job feed route @S-354', () => {
    expect(locationOf('/rss-feed/')).toBe(FEED_JOBS)
  })

  it('leaves the site’s own routes alone @S-350', () => {
    expect(answer('/')).toBeNull()
    expect(answer('/jobs')).toBeNull()
    expect(answer('/jobs/coach-13/')).toBeNull()
  })
})
