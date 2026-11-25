import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  canTransition,
  datesForTransition,
  isLiveJob,
  JOB_STATUSES,
  JOB_END_EARLY_CONTEXT,
  JOB_TRANSITIONS,
  jobTransitionProblem,
  type JobActor,
  type JobStatus,
} from './job-status'

const status = fc.constantFrom(...JOB_STATUSES)
const actor = fc.constantFrom<JobActor>('employer', 'staff', 'system')
const NOW = new Date('2026-11-18T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('job status machine @S-033', () => {
  it('allows exactly the listed moves', () => {
    expect(JOB_TRANSITIONS).toEqual({
      cancelled: [],
      draft: ['waiting_for_purchase', 'pending', 'published', 'cancelled'],
      expired: ['published'],
      pending: ['draft', 'published', 'cancelled', 'waiting_for_purchase'],
      published: ['expired', 'cancelled'],
      waiting_for_purchase: ['cancelled', 'draft', 'pending', 'published'],
    })
  })

  it('lets staff and system make every allowed move, and only those (property) @S-191', () => {
    fc.assert(
      fc.property(status, status, fc.constantFrom<JobActor>('staff', 'system'), (from, to, who) => {
        const problem = jobTransitionProblem(from, to, who)
        expect(problem === null).toBe(from === to || canTransition(from, to))
      }),
    )
  })

  it('lets employers only shuffle their own drafts and pending jobs, or cancel them', () => {
    const allowed = new Set([
      'draft>pending',
      'pending>draft',
      'draft>cancelled',
      'pending>cancelled',
      'waiting_for_purchase>cancelled',
    ])
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const ok = jobTransitionProblem(from, to, 'employer') === null
        expect([`${from}>${to}`, ok]).toEqual([`${from}>${to}`, from === to || allowed.has(`${from}>${to}`)])
      }
    }
  })

  it('marks employer end-early as a server-side action separate from ordinary employer status changes @S-044', () => {
    expect(JOB_END_EARLY_CONTEXT).toBe('jobEndEarly')
    expect(jobTransitionProblem('published', 'expired', 'employer')).toContain('Only staff or checkout')
  })

  it('starts jobs as draft or pending, and for staff and the system also published or waiting for purchase; never expired or cancelled @S-191', () => {
    fc.assert(
      fc.property(status, actor, (to, who) => {
        const ok = jobTransitionProblem(null, to, who) === null
        const expected =
          who === 'employer'
            ? to === 'draft' || to === 'pending'
            : to === 'draft' || to === 'pending' || to === 'published' || to === 'waiting_for_purchase'
        expect(ok).toBe(expected)
      }),
    )
  })

  it('never leaves cancelled, and an employer can never publish, expire or relist (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(status, actor), { maxLength: 12 }), (moves) => {
        let current: JobStatus = 'draft'
        for (const [to, who] of moves) {
          if (jobTransitionProblem(current, to, who) !== null) continue
          if (current === 'cancelled') expect(to).toBe('cancelled')
          if (who === 'employer' && to !== current) {
            expect(['published', 'expired']).not.toContain(to)
          }
          current = to
        }
      }),
    )
  })

  it('refuses statuses that do not exist', () => {
    expect(jobTransitionProblem('draft', 'archived' as JobStatus, 'staff')).toMatch(/not a job status/)
  })
})

describe('datesForTransition', () => {
  // NOW is 23:00 on 18 Nov in Pacific/Efate (UTC+11, no daylight saving).
  const EFATE = 'Pacific/Efate'

  it('publishes now and ends at the end of the local day the plan’s duration later @S-190', () => {
    expect(
      datesForTransition({ durationDays: 45, from: 'pending', now: NOW, timeZone: EFATE, to: 'published' }),
    ).toEqual({ expiresAt: '2027-01-02T12:59:59.999Z', publishedAt: NOW.toISOString() })
    // No timezone known: UTC days, never a guessed tenant.
    expect(datesForTransition({ durationDays: 45, from: 'pending', now: NOW, to: 'published' })).toEqual({
      expiresAt: '2027-01-02T23:59:59.999Z',
      publishedAt: NOW.toISOString(),
    })
  })

  it('counts calendar days across a daylight saving change @S-190', () => {
    // Sydney moves to daylight saving on 4 Oct 2026: 10 days from 1 Oct still ends on 11 Oct.
    const before = new Date('2026-10-01T02:00:00.000Z')
    expect(
      datesForTransition({ durationDays: 10, from: 'draft', now: before, timeZone: 'Australia/Sydney', to: 'published' })
        .expiresAt,
    ).toBe('2026-10-11T12:59:59.999Z')
  })

  it('falls back to UTC for an unknown timezone @S-190', () => {
    expect(
      datesForTransition({ durationDays: 1, from: 'draft', now: NOW, timeZone: 'Not/AZone', to: 'published' }).expiresAt,
    ).toBe('2026-11-19T23:59:59.999Z')
  })

  it('keeps a close date chosen at checkout, clamped to the plan’s duration @S-031 @S-190', () => {
    const inTen = new Date(NOW.getTime() + 10 * DAY).toISOString()
    const inSixty = new Date(NOW.getTime() + 60 * DAY).toISOString()
    const past = new Date(NOW.getTime() - DAY).toISOString()
    const latest = '2027-01-02T12:59:59.999Z'
    const publish = (expiresAt: string, from: 'draft' | 'expired' | 'pending' = 'pending') =>
      datesForTransition({ durationDays: 45, expiresAt, from, now: NOW, timeZone: EFATE, to: 'published' }).expiresAt

    expect(publish(inTen)).toBe(inTen)
    expect(publish(inTen, 'draft')).toBe(inTen)
    expect(publish(inSixty)).toBe(latest)
    expect(publish(past)).toBe(latest)
    // A relist starts afresh, whatever the old expiry was.
    expect(publish(inTen, 'expired')).toBe(latest)
  })

  it('resets publishedAt on relist, and keeps the expiry for staff to set when there is no plan', () => {
    expect(
      datesForTransition({ expiresAt: '2026-01-01T00:00:00.000Z', from: 'expired', now: NOW, to: 'published' }),
    ).toEqual({ publishedAt: NOW.toISOString() })
  })

  it('ends a job early at now, but never moves an expiry that already passed', () => {
    const later = new Date(NOW.getTime() + DAY).toISOString()
    const earlier = new Date(NOW.getTime() - DAY).toISOString()

    expect(datesForTransition({ expiresAt: later, from: 'published', now: NOW, to: 'expired' })).toEqual({
      expiresAt: NOW.toISOString(),
    })
    expect(datesForTransition({ expiresAt: earlier, from: 'published', now: NOW, to: 'expired' })).toEqual({})
    expect(datesForTransition({ from: 'draft', now: NOW, to: 'pending' })).toEqual({})
  })
})

describe('live jobs', () => {
  it('counts only published jobs that have not reached their expiry (property)', () => {
    fc.assert(
      fc.property(status, fc.option(fc.integer({ min: -10, max: 10 }), { nil: null }), (s, offset) => {
        const expiresAt = offset === null ? null : new Date(NOW.getTime() + offset * DAY).toISOString()
        expect(isLiveJob({ expiresAt, status: s }, NOW)).toBe(s === 'published' && (offset === null || offset > 0))
      }),
    )
  })
})
