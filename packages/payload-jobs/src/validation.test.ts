import { describe, expect, it } from 'vitest'

import { contentWriteAccess } from './access'
import {
  isValidPageSlug,
  slugifyTitle,
  validateAnalyticsId,
  validateLinkHref,
  validatePageSlug,
} from './validation'

describe('slugifyTitle', () => {
  it('derives a url-safe slug from a title', () => {
    expect(slugifyTitle('About Us!')).toBe('about-us')
    expect(slugifyTitle('  Terms   &  Conditions  ')).toBe('terms-conditions')
    expect(slugifyTitle('Vanuatu — Work Permits')).toBe('vanuatu-work-permits')
  })

  it('strips accents instead of dropping the letter', () => {
    expect(slugifyTitle('Café Résumé')).toBe('cafe-resume')
  })

  it('does not leave a trailing hyphen when truncating', () => {
    const slug = slugifyTitle(`${'a'.repeat(118)} bc`)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug.length).toBeLessThanOrEqual(120)
  })

  it('returns an empty string when nothing survives', () => {
    expect(slugifyTitle('!!!')).toBe('')
  })
})

describe('validatePageSlug', () => {
  it('accepts lowercase hyphenated slugs', () => {
    for (const slug of ['about-us', 'jobs', 'terms-2026', 'a']) {
      expect(validatePageSlug(slug)).toBe(true)
      expect(isValidPageSlug(slug)).toBe(true)
    }
  })

  it('rejects values that are not a slug', () => {
    for (const slug of ['About-Us', 'about us', 'about--us', '-about', 'about-', 'über']) {
      expect(validatePageSlug(slug)).not.toBe(true)
      expect(isValidPageSlug(slug)).toBe(false)
    }
  })

  it('rejects an empty or over-long slug', () => {
    expect(validatePageSlug('')).not.toBe(true)
    expect(validatePageSlug(undefined)).not.toBe(true)
    expect(validatePageSlug('a'.repeat(121))).not.toBe(true)
  })
})

describe('validateAnalyticsId', () => {
  it('accepts GA4 measurement IDs and Cloudflare Web Analytics tokens', () => {
    expect(validateAnalyticsId('G-ABCDE12345')).toBe(true)
    expect(validateAnalyticsId('  G-ABCDE12345  ')).toBe(true)
    expect(validateAnalyticsId('a'.repeat(32))).toBe(true)
  })

  it('allows an empty value, which means no analytics', () => {
    expect(validateAnalyticsId('')).toBe(true)
    expect(validateAnalyticsId(undefined)).toBe(true)
  })

  it('rejects other formats, such as a legacy UA property', () => {
    expect(validateAnalyticsId('UA-12345-1')).not.toBe(true)
    expect(validateAnalyticsId('G-abc')).not.toBe(true)
    expect(validateAnalyticsId('not a token')).not.toBe(true)
  })
})

describe('validateLinkHref', () => {
  it('accepts paths and absolute URLs', () => {
    for (const href of ['/', '/jobs?category=trades', 'https://vanuatuwok.vu/about']) {
      expect(validateLinkHref(href)).toBe(true)
    }
  })

  it('allows an empty value', () => {
    expect(validateLinkHref('')).toBe(true)
    expect(validateLinkHref(undefined)).toBe(true)
  })

  it('rejects script and relative-without-slash targets', () => {
    for (const href of ['javascript:alert(1)', 'about-us', 'mailto:jobs@example.com', '//evil.example']) {
      expect(validateLinkHref(href)).not.toBe(true)
    }
  })
})

const request = (user: unknown) => ({ req: { user } }) as never

describe('contentWriteAccess', () => {
  it('denies anonymous visitors and employers', () => {
    const access = contentWriteAccess()
    expect(access(request(null))).toBe(false)
    expect(access(request({ id: 1, role: 'user', tenants: [{ tenant: 1, role: 'employer' }] }))).toBe(
      false,
    )
  })

  it('allows super-admins regardless of tenant memberships', () => {
    expect(contentWriteAccess()(request({ id: 1, role: 'super-admin', tenants: [] }))).toBe(true)
  })

  it('allows tenant-admins and editors in at least one tenant', () => {
    const access = contentWriteAccess()
    expect(access(request({ id: 1, role: 'user', tenants: [{ tenant: 1, role: 'tenant-admin' }] }))).toBe(
      true,
    )
    expect(access(request({ id: 2, role: 'user', tenants: [{ tenant: 2, role: 'editor' }] }))).toBe(
      true,
    )
  })

  it('only lets a signed-in user without memberships write when single-tenant mode allows it', () => {
    const user = { id: 1, role: 'user', tenants: [] }
    expect(contentWriteAccess()(request(user))).toBe(false)
    expect(contentWriteAccess({ allowAnyAuthenticated: true })(request(user))).toBe(true)
  })
})
