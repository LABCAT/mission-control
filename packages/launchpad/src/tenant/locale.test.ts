import { describe, expect, it } from 'vitest'

import { resolveLocale } from './locale'

describe('resolveLocale', () => {
  it('takes the tenant default locale', () => {
    expect(resolveLocale({ defaultLocale: 'fr', locales: ['en', 'fr'] })).toBe('fr')
  })

  it('reads a Payload locale row when the default is unset', () => {
    expect(resolveLocale({ locales: [{ locale: 'bi' }, { locale: 'en' }] })).toBe('bi')
  })

  it('ignores an empty default and falls back to en', () => {
    expect(resolveLocale({ defaultLocale: '', locales: ['en'] })).toBe('en')
    expect(resolveLocale({})).toBe('en')
  })
})
