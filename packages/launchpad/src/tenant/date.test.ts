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

  it('keeps a date-only value on its calendar day in a tenant west of UTC', () => {
    // Midnight UTC on 1 Dec is still 30 Nov in Honolulu (UTC-10); a closing date is a calendar day.
    expect(formatDate('2026-12-01', { locale: 'en-GB', timezone: 'Pacific/Honolulu' })).toBe('1 Dec 2026')
    expect(formatDate('2026-12-01', { locale: 'en-GB', timezone: 'Pacific/Efate' })).toBe('1 Dec 2026')
    expect(formatDate('2026-01-01', { locale: 'en', timezone: 'America/Los_Angeles' })).toBe('Jan 1, 2026')
  })

  it('applies the tenant timezone to timestamps, including a Date or epoch input', () => {
    const instant = Date.parse('2026-12-01T05:00:00Z')
    const timezone = 'Pacific/Honolulu'
    expect(formatDate(instant, { locale: 'en-GB', timezone })).toBe('30 Nov 2026')
    expect(formatDate(new Date(instant), { locale: 'en-GB', timezone })).toBe('30 Nov 2026')
    // A Date object holds an instant, so it is converted even when its value is midnight UTC.
    expect(formatDate(new Date('2026-12-01T00:00:00Z'), { locale: 'en-GB', timezone })).toBe('30 Nov 2026')
  })

  it('throws on an invalid date instead of printing "Invalid Date"', () => {
    expect(() => formatDate('not a date')).toThrow(TypeError)
    expect(() => formatDate('2026-02-31')).toThrow(TypeError)
  })
})
