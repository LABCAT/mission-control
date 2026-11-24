import { describe, expect, it } from 'vitest'

import crawl from './legacy-crawl.json' with { type: 'json' }
import { VWOK_SHORTLINKS } from './legacy-shortlinks'
import { normaliseLegacyPath } from '@mission-control/launchpad/redirects'
import { legacyTable, splitPath } from '@mission-control/launchpad/redirects/table'

const paths = crawl.paths as string[]

/**
 * The crawl of the live WordPress site (see `scripts/legacy-paths.mjs`). Every URL it found must
 * have an answer: a redirect, a 410, or the new site's own route. An answer that is missing is a
 * URL a crawler reports as "unmapped", which fails the parity run, so this test is the check the
 * brief asks for.
 *
 * The tables here are the site's real ones: the shortlink map, so `?p=` resolves, and no file
 * table yet, because the media import (PJ-63) writes it per environment.
 */
const table = legacyTable(paths, { shortlinks: VWOK_SHORTLINKS })

describe('the whole crawl is answered @S-126 @S-350', () => {
  it('leaves no crawled URL unanswered @S-126 @S-350', () => {
    const unanswered = paths.filter(
      (path) => !(path in table.redirects) && !table.gone.includes(path) && !table.routes.includes(path),
    )

    expect(unanswered).toEqual([])
  })

  it('answers every redirect with a path on this site @S-350', () => {
    for (const [from, to] of Object.entries(table.redirects)) {
      expect(to.startsWith('/'), `${from} -> ${to}`).toBe(true)
      // A `//` start is a protocol-relative URL, which would leave the site.
      expect(to.startsWith('//'), `${from} -> ${to}`).toBe(false)
    }
  })

  it('never sends a crawled URL to another legacy URL @S-359', () => {
    for (const [from, to] of Object.entries(table.redirects)) {
      const [pathname, search] = splitPath(to)
      // `/jobs?page=2` and `/jobs?q=…` are the listing's own URLs, so the only legacy answer they
      // can get is none; anything else would make a visitor wait for two round trips.
      const followUp = legacyTable([search ? `${pathname}${search}` : pathname], {
        shortlinks: VWOK_SHORTLINKS,
      })
      expect(followUp.redirects, `${from} -> ${to}`).toEqual({})
    }
  })

  it('keeps the CV module out of the redirect table, because it is 410 @S-353', () => {
    const cvRedirects = Object.keys(table.redirects).filter((path) => /^\/resumes\b/.test(path))
    expect(cvRedirects).toEqual([])

    const cvPaths = paths.filter((path) => /^\/resumes\b/.test(path))
    expect(cvPaths.length).toBeGreaterThan(0)
    for (const path of cvPaths) expect(table.gone, path).toContain(path)
  })

  it('sends the retired promo pages to 410, not to a redirect @S-353', () => {
    for (const path of ['/land-law-reforms/', '/organisation-competition/', '/job-email-text/', '/no-resumes/']) {
      expect(table.gone, path).toContain(path)
    }
  })

  it('has the job pages and the live content pages answered by their own routes @S-354', () => {
    for (const path of ['/jobs/', '/jobs/executive-chef-16/', '/organisations/', '/contact/']) {
      expect(table.routes, path).toContain(path)
    }
  })

  it('answers each legacy taxonomy class with the clean filter URL @S-351', () => {
    expect(table.redirects['/job-category/education/']).toBe('/jobs/education')
    expect(table.redirects['/job-type/full-time/']).toBe('/jobs/full-time')
    expect(table.redirects['/job-salary/not-stated/']).toBe('/jobs?salary=not-stated')
    expect(table.redirects['/job-type/voluntary/board-position/']).toBe('/jobs/board-position')
  })

  it('answers each organisation profile and its feed @S-352', () => {
    expect(table.redirects['/organisation/oxfam/']).toBe('/organisations/oxfam')
    expect(table.redirects['/organisation/oxfam/feed/']).toBe('/organisations/oxfam')
    expect(table.redirects['/organisation/bred-bank-(vanuatu)-limited/']).toBe(
      '/organisations/bred-bank-vanuatu-limited',
    )
  })

  it('answers every shortlink the crawl followed @S-357', () => {
    const shortlinkPaths = paths.filter((path) => /^\/(?:\?p=)\d+$/.test(path))
    expect(shortlinkPaths.length).toBeGreaterThan(20)

    for (const path of shortlinkPaths) {
      const id = Number(path.slice(4))
      const answers = path in table.redirects || table.gone.includes(path)
      expect(answers, path).toBe(true)
      expect(VWOK_SHORTLINKS.has(id), path).toBe(!table.gone.includes(path))
    }
  })

  it('answers the old search and date-archive URLs by moving them to the listing @S-356', () => {
    expect(table.redirects['/job-date-archive/?time=week&jobs_by_date=1']).toBe('/jobs')
    expect(table.redirects['/feed/?rss_featured=1']).toBe('/feed/jobs.xml')
  })
})

const normalised = (path: string): string => normaliseLegacyPath(splitPath(path)[0]).path

describe('legacy table: duplicate spellings @S-350', () => {
  it('collapses the duplicate spellings of a path onto one target @S-350', () => {
    // The crawl found `/jobs` and `/jobs/`, `/about-us` and `/about-us/`; they are one URL. A
    // shortlink is keyed by its id, not its path, so those are compared separately (above).
    const targets = new Map<string, string>()
    for (const [from, to] of Object.entries(table.redirects)) {
      if (from.includes('?p=')) continue
      const key = normalised(from)
      const seen = targets.get(key)
      if (seen) expect(seen, `${from} vs ${key}`).toBe(to)
      else targets.set(key, to)
    }
  })
})
