import { brandingTokens } from '@mission-control/launchpad'
import { describe, expect, it } from 'vitest'

import { BRAND, LOGO, PRODUCTION_HOSTNAMES, siteTenant } from './brand'
import { isCrawlableHost, isProductionHost, robotsTxt } from './robots'

describe('Vanuatu Wok branding', () => {
  it('maps the legacy palette onto Rocketship tokens and nothing else', () => {
    expect(brandingTokens(siteTenant.branding)).toEqual({
      '--rs-color-accent': '#06914b',
      '--rs-color-accent-contrast': '#000000',
      '--rs-color-accent-hover': '#0066bf',
      '--rs-color-focus-ring': '#dd3333',
      '--rs-color-link': '#06914b',
      '--rs-color-link-hover': '#0066bf',
    })
  })

  it('keeps the legacy colours as given', () => {
    expect(BRAND).toEqual({
      colorAccent: '#dd3333',
      colorHover: '#0066bf',
      colorPrimary: '#06914b',
    })
  })

  it('ships the logo with its real dimensions, so the header cannot shift', () => {
    expect(LOGO).toEqual({
      alt: 'Vanuatu Wok',
      height: 86,
      src: '/brand/vanuatu-wok-logo.png',
      width: 400,
    })
    expect(siteTenant.branding?.logo).toEqual({
      alt: 'Vanuatu Wok',
      height: 86,
      url: '/brand/vanuatu-wok-logo.png',
      width: 400,
    })
  })
})

const SITEMAP = 'https://vanuatuwok.vu/sitemap.xml'

/** The AI group is the second one in the text; the first is the wildcard group. */
const aiGroup = (text: string): string => text.split('\n\n')[1] ?? ''

describe('robots.txt @S-124', () => {
  it('lets search engines crawl production', () => {
    for (const hostname of PRODUCTION_HOSTNAMES) {
      expect(robotsTxt(hostname, { sitemapUrl: SITEMAP })).toContain('User-agent: *')
      expect(robotsTxt(hostname, { sitemapUrl: SITEMAP })).not.toContain('Disallow: /\n')
    }
  })

  it('matches production case-insensitively, as hostnames are case-insensitive', () => {
    expect(robotsTxt('VANUATUWOK.VU')).toBe(robotsTxt('vanuatuwok.vu'))
  })

  it('blocks a preview from being indexed as a copy of the site', () => {
    // A workers.dev deployment and a PR preview both serve production's pages.
    expect(robotsTxt('mc-vwok.labcat.workers.dev')).toBe('User-agent: *\nDisallow: /\n')
    expect(robotsTxt('feature-x-mc-vwok.labcat.workers.dev')).toBe(
      'User-agent: *\nDisallow: /\n',
    )
  })

  it('points production at the live sitemap', () => {
    expect(robotsTxt('vanuatuwok.vu', { sitemapUrl: SITEMAP })).toContain(`Sitemap: ${SITEMAP}`)
  })

  it('leaves a developer server alone, so Lighthouse can score a crawlable page', () => {
    for (const hostname of ['127.0.0.1', 'localhost']) {
      expect(isCrawlableHost(hostname)).toBe(true)
    }
  })

  it('lets AI crawlers in by default, and out only when the deployment says so', () => {
    const allowed = robotsTxt('vanuatuwok.vu', { sitemapUrl: SITEMAP })
    const blocked = robotsTxt('vanuatuwok.vu', { aiCrawlersAllowed: false, sitemapUrl: SITEMAP })

    expect(aiGroup(allowed)).toContain('User-agent: GPTBot')
    expect(aiGroup(allowed).split('\n')).not.toContain('Disallow: /')
    expect(aiGroup(blocked).split('\n')).toContain('Disallow: /')
  })

  it('does not treat a lookalike domain as production', () => {
    // `vanuatuwok.vu.example.com` ends with the domain but is somebody else's host.
    expect(isProductionHost('vanuatuwok.vu.evil.example')).toBe(false)
    expect(isProductionHost('notvanuatuwok.vu')).toBe(false)
    expect(isProductionHost('vanuatuwok.vu')).toBe(true)
  })
})
