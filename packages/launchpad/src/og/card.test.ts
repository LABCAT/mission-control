import { describe, expect, it } from 'vitest'

import type { JobDetailView } from '../jobs/detail'
import type { OrganisationProfile } from '../organisations/profile'
import type { SiteTenant } from '../tenant/types'
import { clamp, homeCard, jobCard, OG_HEIGHT, OG_WIDTH, organisationCard } from './card'

const tenant: SiteTenant = {
  branding: { colorPrimary: '#1B7F4B', logo: { url: '/brand/logo.png', width: 200, height: 60 } },
  name: 'Vanuatu Wok',
}

const jobView = (overrides: { detail?: Record<string, unknown>; tenant?: SiteTenant } = {}) =>
  ({
    detail: {
      categories: ['Hospitality'],
      categoryIds: [1],
      id: 7,
      jobType: 'Full time',
      location: 'Port Vila',
      organisation: { name: 'Acme Hospitality' },
      slug: 'head-chef',
      title: 'Head Chef',
      url: '/jobs/head-chef',
      ...overrides.detail,
    },
    tenant: overrides.tenant ?? tenant,
  }) as unknown as Pick<JobDetailView, 'detail' | 'tenant'>

const profile = (overrides: Partial<OrganisationProfile> = {}): OrganisationProfile => ({
  initials: 'AH',
  jobs: [],
  name: 'Acme Hospitality',
  slug: 'acme',
  ...overrides,
})

describe('share card', () => {
  it('is 1200x630, the size social scrapers expect @S-250', () => {
    expect([OG_WIDTH, OG_HEIGHT]).toEqual([1200, 630])
  })

  it('draws a job from the page data, in the tenant palette @S-251', () => {
    const card = jobCard({ view: jobView({ detail: { displayedSalary: 'VT 90,000' } }) })

    expect(card).toMatchObject({
      accent: '#1b7f4b',
      accentText: '#ffffff',
      eyebrow: 'Vanuatu Wok',
      facts: ['Port Vila', 'Full time', 'VT 90,000'],
      kind: 'job',
      siteName: 'Vanuatu Wok',
      subtitle: 'Acme Hospitality',
      title: 'Head Chef',
    })
  })

  it("prefers the organisation's logo and falls back to the site's @S-251", () => {
    const own = jobCard({
      view: jobView({ detail: { organisation: { name: 'Acme', logo: { url: 'https://cms/acme.png' } } } }),
    })
    expect(own.logo).toEqual({ url: 'https://cms/acme.png' })

    // A site logo given as a path is made absolute against the deployment's origin.
    const fallback = jobCard({ origin: 'https://vanuatuwok.vu', view: jobView() })
    expect(fallback.logo).toEqual({ url: 'https://vanuatuwok.vu/brand/logo.png' })
  })

  it('omits a logo the card cannot resolve, rather than drawing a broken one @S-251', () => {
    const card = jobCard({
      origin: 'not a url',
      view: jobView({
        detail: { organisation: { name: 'Acme', logo: { url: 'javascript:alert(1)' } } },
        tenant: { branding: { logo: null }, name: 'Vanuatu Wok' },
      }),
    })

    expect(card.logo).toBeUndefined()
  })

  it('uses a neutral accent when the tenant has no valid colour @S-251', () => {
    const card = jobCard({ view: jobView({ tenant: { branding: { colorPrimary: 'blue' }, name: 'X' } }) })

    expect(card.accent).toBe('#1f2937')
    expect(card.accentText).toBe('#ffffff')
  })

  it('picks black text on a light accent, so the pills stay readable @S-251', () => {
    const card = jobCard({
      view: jobView({ tenant: { branding: { colorPrimary: '#FFEE00' }, name: 'X' } }),
    })

    expect(card.accentText).toBe('#000000')
  })

  it('clamps long text so it cannot overflow the card @S-252', () => {
    const long = 'Senior Front of House Manager for a busy waterfront restaurant in Port Vila'
    const card = jobCard({ view: jobView({ detail: { title: long } }) })

    expect(card.title.length).toBeLessThanOrEqual(70)
    expect(card.title.endsWith('…')).toBe(true)

    // The kept text is a prefix of the original that stops at a space: no half a word survives.
    const kept = card.title.slice(0, -1)
    expect(long.startsWith(kept)).toBe(true)
    expect(long[kept.length]).toBe(' ')
  })

  it('leaves short text alone @S-252', () => {
    expect(clamp('Head Chef', 70)).toBe('Head Chef')
    expect(clamp('  Head    Chef  ', 70)).toBe('Head Chef')
  })

  it('draws an organisation with its type, size and location @S-253', () => {
    const card = organisationCard({
      origin: 'https://vanuatuwok.vu',
      profile: profile({ location: 'Port Vila', sizeLabel: '11-50', typeLabel: 'Restaurant' }),
      tenant,
    })

    expect(card).toMatchObject({
      facts: ['Restaurant', '11-50', 'Port Vila'],
      kind: 'organisation',
      title: 'Acme Hospitality',
    })
    expect(card.subtitle).toBeUndefined()
  })

  it("falls back to the site's logo when the organisation has none @S-253", () => {
    expect(organisationCard({ origin: 'https://vw.vu', profile: profile(), tenant }).logo).toEqual({
      url: 'https://vw.vu/brand/logo.png',
    })
  })

  it('draws the home page with its own title and description @S-254', () => {
    const card = homeCard({
      description: 'Vacancies from employers across Vanuatu.',
      tenant,
      title: 'Find a job in Vanuatu',
    })

    expect(card).toMatchObject({
      facts: [],
      kind: 'home',
      subtitle: 'Vacancies from employers across Vanuatu.',
      title: 'Find a job in Vanuatu',
    })
  })

  it('names the tenant on the home page when the CMS has no title @S-254', () => {
    const card = homeCard({ tenant: { name: 'Vanuatu Wok' } })

    expect(card.title).toBe('Vanuatu Wok')
    expect(card.subtitle).toBeUndefined()
  })
})
