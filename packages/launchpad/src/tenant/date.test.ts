import { describe, expect, it } from 'vitest'

import { formatDate } from './date'

describe('formatDate', () => {
  it('formats the date the way the tenant locale writes it', () => {
    expect(formatDate('2026-11-15T00:00:00Z', { locale: 'en-GB' })).toBe('15 Nov 2026')
    expect(formatDate('2026-11-15T00:00:00Z', { locale: 'en' })).toBe('Nov 15, 2026')
    expect(formatDate(new Date('2026-01-02T12:00:00Z'), { locale: 'en-GB' })).toBe('2 Jan 2026')
  })

  it('uses the tenant timezone, so a late UTC posting is not shown as the next day', () => {
    // 2026-11-15T23:30Z is 2026-11-16 10:30 in Pacific/Efate (UTC+11).
    const instant = '2026-11-15T23:30:00Z'
    expect(formatDate(instant, { locale: 'en-GB', timezone: 'UTC' })).toBe('15 Nov 2026')
    expect(formatDate(instant, { locale: 'en-GB', timezone: 'Pacific/Efate' })).toBe('16 Nov 2026')
  })

  it('throws on an invalid date instead of printing "Invalid Date"', () => {
    expect(() => formatDate('not a date')).toThrow(TypeError)
  })
})
