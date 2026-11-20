import { describe, expect, it } from 'vitest'

import { slugifyPageTitle, validatePageSlug } from './pages'
import { validateMenuUrl } from './menus'

describe('page slugs', () => {
  it('derives a slug from the title', () => {
    expect(slugifyPageTitle('About Us!')).toBe('about-us')
    expect(slugifyPageTitle('  For   Employers  ')).toBe('for-employers')
    expect(slugifyPageTitle('Café Crème')).toBe('cafe-creme')
  })

  it('accepts lowercase hyphenated slugs and rejects anything else', () => {
    expect(validatePageSlug('about-us')).toBe(true)
    expect(validatePageSlug('')).toBe(true)
    expect(validatePageSlug(null)).toBe(true)
    expect(validatePageSlug('About Us')).toMatch(/lowercase letters/)
    expect(validatePageSlug('about_us')).toMatch(/lowercase letters/)
    expect(validatePageSlug('-about')).toMatch(/lowercase letters/)
  })

  it('refuses a slug longer than the cap', () => {
    expect(validatePageSlug('a'.repeat(121))).toMatch(/lowercase letters/)
  })
})

describe('menu item URLs', () => {
  it('accepts paths, anchors, absolute URLs and contact links', () => {
    for (const url of ['/jobs', '/organisations/vanuatu-brewing', '#main', '?page=2']) {
      expect(validateMenuUrl(url)).toBe(true)
    }
    for (const url of ['https://example.com', 'mailto:hello@example.com', 'tel:+6781234']) {
      expect(validateMenuUrl(url)).toBe(true)
    }
  })

  it('rejects an empty link and a dangerous scheme', () => {
    expect(validateMenuUrl('')).toMatch(/needs a link/)
    expect(validateMenuUrl(undefined)).toMatch(/needs a link/)
    expect(validateMenuUrl('javascript:alert(1)')).toMatch(/http, https, mailto or tel/)
    expect(validateMenuUrl('data:text/html,<script>')).toMatch(/http, https, mailto or tel/)
  })

  it('rejects a scheme hidden behind whitespace or control characters', () => {
    expect(validateMenuUrl('java\tscript:alert(1)')).toMatch(/http, https, mailto or tel/)
    expect(validateMenuUrl('  javascript:alert(1)')).toMatch(/http, https, mailto or tel/)
  })

  it('rejects protocol-relative URLs, which would leave the site', () => {
    expect(validateMenuUrl('//evil.example')).toMatch(/protocol-relative/)
    expect(validateMenuUrl('/\\evil.example')).toMatch(/protocol-relative/)
  })
})
