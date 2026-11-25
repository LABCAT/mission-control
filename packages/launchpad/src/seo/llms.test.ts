import { describe, expect, it } from 'vitest'

import type { SiteTenant } from '../tenant/types'
import { llmsTxt } from './llms'

const tenant: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

const SITE = 'https://vanuatuwok.vu'

describe('llmsTxt @S-348', () => {
  it('opens with the site name and a summary, then the key URLs', () => {
    expect(llmsTxt({ siteUrl: SITE, tenant })).toMatchSnapshot()
  })

  it('makes every URL absolute, so an agent that fetched the file alone can follow them', () => {
    const text = llmsTxt({ siteUrl: `${SITE}/`, tenant })

    expect(text).toContain(`(${SITE}/jobs)`)
    expect(text).toContain(`(${SITE}/organisations)`)

    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      expect(match[1]?.startsWith('https://')).toBe(true)
    }
  })

  it('lists live jobs, organisations and pages in their own sections', () => {
    const text = llmsTxt({
      jobs: [{ name: 'Head Chef', path: '/jobs/head-chef' }],
      organisations: [{ name: 'Santo Bakery', path: '/organisations/santo-bakery' }],
      pages: [{ links: [{ name: 'About us', path: '/about' }], title: 'Pages' }],
      siteUrl: SITE,
      tenant,
    })

    expect(text).toContain('## Live jobs')
    expect(text).toContain(`- [Head Chef](${SITE}/jobs/head-chef)`)
    expect(text).toContain('## Organisations')
    expect(text).toContain(`- [Santo Bakery](${SITE}/organisations/santo-bakery)`)
    expect(text).toContain('## Pages')
    expect(text).toContain(`- [About us](${SITE}/about)`)
  })

  it('leaves an empty section out rather than printing a heading with nothing under it', () => {
    const text = llmsTxt({ siteUrl: SITE, tenant })

    expect(text).not.toContain('## Live jobs')
    expect(text).not.toContain('## Organisations')
  })

  it('uses the site’s own summary when it has one', () => {
    expect(llmsTxt({ description: ' Jobs in Vanuatu. ', siteUrl: SITE, tenant })).toContain(
      '> Jobs in Vanuatu.',
    )
  })

  it('puts a note after a link when it was given one', () => {
    const text = llmsTxt({ siteUrl: SITE, tenant })

    expect(text).toContain(`- [Jobs](${SITE}/jobs): every live job, with filters`)
  })
})
