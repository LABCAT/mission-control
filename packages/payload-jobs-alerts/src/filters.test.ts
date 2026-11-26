import { describe, expect, it } from 'vitest'

import {
  alertFilterKey,
  alertQueryString,
  isDisposableEmail,
  normaliseAlertFilterInput,
  normaliseSubscriberEmail,
} from './filters'

describe('alert filters @S-371', () => {
  it('reads the listing filter names, trimmed, lowercase slugs, keywords tidied', () => {
    expect(
      normaliseAlertFilterInput({
        category: ' IT-Jobs ',
        location: 'Efate',
        q: '  Hotel   Manager ',
        type: 'full-time',
      }),
    ).toEqual({ category: 'it-jobs', location: 'efate', q: 'Hotel Manager', type: 'full-time' })
  })

  it('drops empty, non-string and unknown filters instead of storing them', () => {
    expect(
      normaliseAlertFilterInput({ category: '', extra: 'x', location: 5, page: '2', q: '   ' } as never),
    ).toEqual({})
  })

  it('refuses keywords or slugs longer than the collection allows', () => {
    expect(() => normaliseAlertFilterInput({ q: 'x'.repeat(201) })).toThrow(/keywords/)
    expect(() => normaliseAlertFilterInput({ category: 'a'.repeat(201) })).toThrow(/category/)
  })

  it('writes the query in the listing order, so one filter is one string', () => {
    expect(alertQueryString({ category: 'it', location: 'efate', q: 'driver', type: 'full-time' })).toBe(
      'q=driver&category=it&type=full-time&location=efate',
    )
    expect(alertQueryString({})).toBe('')
  })

  it('gives the same key for the same search however it was typed', () => {
    const a = alertFilterKey({ categories: [3, 1], keywords: 'Hotel  Manager', locations: [], types: [] })
    const b = alertFilterKey({ categories: ['1', '3'], keywords: ' hotel manager ', locations: null, types: undefined })

    expect(a).toBe(b)
  })

  it('gives different keys for different searches, so two alerts per address can coexist', () => {
    const base = { categories: [1], keywords: null, locations: [], types: [] }

    expect(alertFilterKey(base)).not.toBe(alertFilterKey({ ...base, categories: [2] }))
    expect(alertFilterKey(base)).not.toBe(alertFilterKey({ ...base, categories: [], types: [1] }))
    expect(alertFilterKey(base)).not.toBe(alertFilterKey({ ...base, keywords: 'nurse' }))
    expect(alertFilterKey({ categories: [], keywords: null, locations: [], types: [] })).toBe('')
  })
})

describe('subscriber email @S-372', () => {
  it('lowercases and trims, and refuses things that are not addresses', () => {
    expect(normaliseSubscriberEmail('  Jo@Example.COM ')).toBe('jo@example.com')
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@@c.com', `${'a'.repeat(250)}@c.com`, 5, null]) {
      expect(normaliseSubscriberEmail(bad)).toBeNull()
    }
  })

  it('blocks well-known disposable domains, subdomains included', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true)
    expect(isDisposableEmail('x@sub.mailinator.com')).toBe(true)
    expect(isDisposableEmail('x@gmail.com')).toBe(false)
    expect(isDisposableEmail('x@notmailinator.com')).toBe(false)
  })

  it('takes a tenant-extended block list', () => {
    expect(isDisposableEmail('x@spam.test', ['SPAM.test'])).toBe(true)
  })
})
