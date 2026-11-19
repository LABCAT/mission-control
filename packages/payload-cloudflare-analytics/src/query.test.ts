import { describe, expect, it } from 'vitest'

import { ANALYTICS_QUERY, analyticsWindow, buildAnalyticsQuery, parseAnalyticsRange } from './query'

describe('GraphQL query building', () => {
  it('asks the RUM dataset for totals, pages, referrers and a daily series', () => {
    for (const alias of ['totals:', 'pages:', 'referrers:', 'daily:']) {
      expect(ANALYTICS_QUERY).toContain(alias)
    }
    expect(ANALYTICS_QUERY).toContain('rumPageloadEventsAdaptiveGroups')
    expect(ANALYTICS_QUERY).toContain('requestPath')
    expect(ANALYTICS_QUERY).toContain('refererHost')
    expect(ANALYTICS_QUERY).toContain('orderBy: [count_DESC]')
    expect(ANALYTICS_QUERY).toContain('orderBy: [date_ASC]')
    expect(ANALYTICS_QUERY).toContain('siteTag: $siteTag')
    expect(ANALYTICS_QUERY).toContain('datetime_geq: $start')
    expect(ANALYTICS_QUERY).toContain('datetime_leq: $end')
  })

  it('builds variables for a 7 day window without putting the token in the query', () => {
    const variables = buildAnalyticsQuery({
      accountId: 'account-123',
      end: new Date('2026-11-19T12:00:00.000Z'),
      siteTag: 'site-abc',
      start: new Date('2026-11-13T00:00:00.000Z'),
    })
    expect(variables).toEqual({
      accountTag: 'account-123',
      end: '2026-11-19T12:00:00.000Z',
      siteTag: 'site-abc',
      start: '2026-11-13T00:00:00.000Z',
    })
    expect(JSON.stringify({ query: ANALYTICS_QUERY, variables })).not.toContain('Bearer')
  })

  it('starts the window at UTC midnight, including today', () => {
    const now = new Date('2026-11-19T23:45:00.000Z')
    expect(analyticsWindow(now, 7)).toEqual({
      end: now,
      start: new Date('2026-11-13T00:00:00.000Z'),
    })
    expect(analyticsWindow(now, 30)).toEqual({
      end: now,
      start: new Date('2026-10-21T00:00:00.000Z'),
    })
  })

  it('accepts only 7 and 30 day ranges', () => {
    expect(parseAnalyticsRange('30')).toBe(30)
    expect(parseAnalyticsRange(['7', '30'])).toBe(7)
    expect(parseAnalyticsRange('365')).toBe(7)
    expect(parseAnalyticsRange(undefined)).toBe(7)
  })
})
