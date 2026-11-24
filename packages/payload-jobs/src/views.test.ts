import { describe, expect, it } from 'vitest'

import type { RateLimiter } from './rate-limit'
import { countedViews, isBotUserAgent, viewDayKey, viewsOn } from './views'

describe('job view counting rules @S-287', () => {
  it('names a bot from its user agent, and treats a missing one as a bot', () => {
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'facebookexternalhit/1.1',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0.0.0',
      'curl/8.4.0',
      'python-requests/2.31.0',
      'Mozilla/5.0 (compatible; UptimeRobot/2.0)',
      '',
      '   ',
    ]) {
      expect(isBotUserAgent(agent), JSON.stringify(agent)).toBe(true)
    }

    for (const agent of [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
    ]) {
      expect(isBotUserAgent(agent), agent).toBe(false)
    }
  })

  it('takes today from the tenant clock, not UTC', () => {
    // 02:00 UTC on 2 Jan is 13:00 the same day in Efate (UTC+11)…
    expect(viewDayKey(new Date('2027-01-01T15:00:00Z'), 'Pacific/Efate')).toBe('2027-01-02')
    // …and still 1 Jan in UTC.
    expect(viewDayKey(new Date('2027-01-01T15:00:00Z'))).toBe('2027-01-01')
    // A tenant west of UTC is still on the previous day.
    expect(viewDayKey(new Date('2027-01-02T02:00:00Z'), 'America/Los_Angeles')).toBe('2027-01-01')
  })

  it('falls back to UTC for a missing or invalid timezone', () => {
    const at = new Date('2027-01-01T15:00:00Z')

    expect(viewDayKey(at, null)).toBe('2027-01-01')
    expect(viewDayKey(at, '')).toBe('2027-01-01')
    expect(viewDayKey(at, 'Mars/Olympus_Mons')).toBe('2027-01-01')
  })

  it('adds one to the total and to today’s row', () => {
    const counted = countedViews({ viewDays: [{ count: 4, day: '2027-01-01' }], views: 10 }, '2027-01-01')

    expect(counted).toEqual({
      today: 5,
      total: 11,
      viewDays: [{ count: 5, day: '2027-01-01' }],
    })
  })

  it('starts a new day row and keeps the newest days first', () => {
    const counted = countedViews(
      {
        viewDays: [
          { count: 2, day: '2027-01-01' },
          { count: 9, day: '2026-12-31' },
        ],
        views: 11,
      },
      '2027-01-02',
    )

    expect(counted.today).toBe(1)
    expect(counted.viewDays).toEqual([
      { count: 1, day: '2027-01-02' },
      { count: 2, day: '2027-01-01' },
      { count: 9, day: '2026-12-31' },
    ])
  })

  it('keeps only the last week of day rows', () => {
    const old = Array.from({ length: 10 }, (_, index) => ({
      count: 1,
      day: `2026-12-${String(index + 1).padStart(2, '0')}`,
    }))

    const counted = countedViews({ viewDays: old, views: 10 }, '2027-01-15')

    expect(counted.viewDays).toHaveLength(8)
    expect(counted.viewDays[0]).toEqual({ count: 1, day: '2027-01-15' })
    // The oldest two fell off the end.
    expect(counted.viewDays.map((row) => row.day)).not.toContain('2026-12-01')
  })

  it('survives rubbish stored counts instead of throwing', () => {
    const counted = countedViews(
      { viewDays: [{ count: -5, day: '2027-01-01' }, { count: Number.NaN, day: '2027-01-01' }], views: -3 },
      '2027-01-01',
    )

    expect(counted.today).toBe(1)
    expect(counted.total).toBe(1)
  })

  it('reads today’s count without changing anything', () => {
    expect(
      viewsOn({ viewDays: [{ count: 3, day: '2027-01-01' }], views: 42 }, '2027-01-01'),
    ).toEqual({ today: 3, total: 42 })
    expect(viewsOn({ viewDays: null, views: null }, '2027-01-01')).toEqual({ today: 0, total: 0 })
  })
})

describe('view limiter contract @S-287', () => {
  it('matches the Cloudflare binding shape', async () => {
    const limiter: RateLimiter = { limit: async () => ({ success: true }) }

    await expect(limiter.limit({ key: 'job-view:1:203.0.113.9' })).resolves.toEqual({ success: true })
  })
})
