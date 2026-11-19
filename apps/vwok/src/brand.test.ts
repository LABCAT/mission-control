import { brandingTokens } from '@mission-control/launchpad'
import { describe, expect, it } from 'vitest'

import { isProductionHost, robotsTxt } from './robots'
import { BRAND, LOGO, PRODUCTION_HOSTNAMES, siteTenant } from './brand'

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

describe('robots.txt', () => {
  it('lets search engines crawl production', () => {
    for (const hostname of PRODUCTION_HOSTNAMES) {
      expect(robotsTxt(hostname)).toBe('User-agent: *\nAllow: /\n')
    }
  })

  it('matches production case-insensitively, as hostnames are case-insensitive', () => {
    expect(robotsTxt('VANUATUWOK.VU')).toBe('User-agent: *\nAllow: /\n')
  })

  it('blocks a preview from being indexed as a copy of the site', () => {
    // A workers.dev deployment and a PR preview both serve production's pages.
    expect(robotsTxt('mc-vwok.labcat.workers.dev')).toBe('User-agent: *\nDisallow: /\n')
    expect(robotsTxt('feature-x-mc-vwok.labcat.workers.dev')).toBe(
      'User-agent: *\nDisallow: /\n',
    )
  })

  it('leaves a developer server alone, so Lighthouse can score a crawlable page', () => {
    expect(robotsTxt('127.0.0.1')).toBe('User-agent: *\nAllow: /\n')
    expect(robotsTxt('localhost')).toBe('User-agent: *\nAllow: /\n')
  })

  it('does not treat a lookalike domain as production', () => {
    // `vanuatuwok.vu.example.com` ends with the domain but is somebody else's host.
    expect(isProductionHost('vanuatuwok.vu.evil.example')).toBe(false)
    expect(isProductionHost('notvanuatuwok.vu')).toBe(false)
    expect(isProductionHost('vanuatuwok.vu')).toBe(true)
  })
})
