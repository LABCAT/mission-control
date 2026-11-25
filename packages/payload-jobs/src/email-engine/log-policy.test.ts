import { describe, expect, it } from 'vitest'

import {
  DEFAULT_LOG_DELETE_MONTHS,
  DEFAULT_LOG_VISIBLE_DAYS,
  logCutoffs,
  logRetention,
  maskEmail,
  monthRange,
} from './log-policy'

describe('maskEmail @S-184', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('jane@example.com')).toBe('j***@example.com')
    expect(maskEmail('J.Smith+tag@Mail.Example.org')).toBe('J***@Mail.Example.org')
  })

  it('masks a one-letter local part completely and never returns the original', () => {
    expect(maskEmail('j@example.com')).toBe('*@example.com')
  })

  it('masks anything that is not an address', () => {
    expect(maskEmail('not an address')).toBe('***')
    expect(maskEmail('')).toBe('***')
    expect(maskEmail('@example.com')).toBe('***')
  })

  it('is stable: masking a masked address changes nothing', () => {
    expect(maskEmail(maskEmail('jane@example.com'))).toBe('j***@example.com')
  })
})

describe('logRetention @S-184', () => {
  it('defaults to the founder decision: 90 days visible, 12 months kept', () => {
    expect(logRetention(null)).toEqual({ deleteMonths: 12, visibleDays: 90 })
    expect(DEFAULT_LOG_VISIBLE_DAYS).toBe(90)
    expect(DEFAULT_LOG_DELETE_MONTHS).toBe(12)
  })

  it('reads the tenant settings', () => {
    expect(logRetention({ emailLogRetention: { deleteMonths: 6, visibleDays: 30 } })).toEqual({
      deleteMonths: 6,
      visibleDays: 30,
    })
  })

  it('falls back to the defaults for a malformed value rather than deleting early', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, '12', null, undefined]) {
      expect(logRetention({ emailLogRetention: { deleteMonths: bad, visibleDays: bad } })).toEqual({
        deleteMonths: 12,
        visibleDays: 90,
      })
    }
  })

  it('never masks later than it deletes: visible days are capped to the delete period', () => {
    const { visibleDays } = logRetention({ emailLogRetention: { deleteMonths: 1, visibleDays: 400 } })
    expect(visibleDays).toBeLessThanOrEqual(31)
  })
})

describe('logCutoffs @S-184', () => {
  const now = new Date('2026-11-24T03:30:00Z')

  it('masks rows older than the visible period, to the second', () => {
    const { maskBefore } = logCutoffs({ deleteMonths: 12, visibleDays: 90 }, now)
    expect(maskBefore.toISOString()).toBe('2026-08-26T03:30:00.000Z')
  })

  it('deletes rows older than the delete period, in calendar months', () => {
    const { deleteBefore } = logCutoffs({ deleteMonths: 12, visibleDays: 90 }, now)
    expect(deleteBefore.toISOString()).toBe('2025-11-24T03:30:00.000Z')
  })

  it('a 31st does not skip a short month', () => {
    const { deleteBefore } = logCutoffs({ deleteMonths: 1, visibleDays: 1 }, new Date('2026-03-31T00:00:00Z'))
    expect(deleteBefore.toISOString()).toBe('2026-02-28T00:00:00.000Z')
  })
})

describe('monthRange @S-185', () => {
  it('is a half-open UTC month', () => {
    const { from, to } = monthRange('2026-11')
    expect(from.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(to.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('rolls the year over in December', () => {
    expect(monthRange('2026-12').to.toISOString()).toBe('2027-01-01T00:00:00.000Z')
  })

  it('rejects anything that is not YYYY-MM', () => {
    for (const bad of ['2026-13', '2026-00', '26-11', '2026-1', 'nov', '']) {
      expect(() => monthRange(bad)).toThrow()
    }
  })
})
