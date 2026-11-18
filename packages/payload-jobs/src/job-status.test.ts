import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  canTransition,
  datesForTransition,
  decidePublication,
  isLiveJob,
  JOB_STATUSES,
  JOB_TRANSITIONS,
  jobTransitionProblem,
  type JobActor,
  type JobStatus,
} from './job-status'

const status = fc.constantFrom(...JOB_STATUSES)
const actor = fc.constantFrom<JobActor>('employer', 'staff', 'system')
const NOW = new Date('2026-11-18T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

describe('job status machine', () => {
  it('allows exactly the listed moves', () => {
    expect(JOB_TRANSITIONS).toEqual({
      cancelled: [],
      draft: ['pending', 'published', 'cancelled'],
      expired: ['published'],
      pending: ['draft', 'published', 'cancelled'],
      published: ['expired', 'cancelled'],
    })
  })

  it('lets staff and system make every allowed move, and only those (property)', () => {
    fc.assert(
      fc.property(status, status, fc.constantFrom<JobActor>('staff', 'system'), (from, to, who) => {
        const problem = jobTransitionProblem(from, to, who)
        expect(problem === null).toBe(from === to || canTransition(from, to))
      }),
    )
  })

  it('lets employers only shuffle their own drafts and pending jobs, or cancel them', () => {
    const allowed = new Set(['draft>pending', 'pending>draft', 'draft>cancelled', 'pending>cancelled'])
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const ok = jobTransitionProblem(from, to, 'employer') === null
        expect([`${from}>${to}`, ok]).toEqual([`${from}>${to}`, from === to || allowed.has(`${from}>${to}`)])
      }
    }
  })

  it('starts jobs as draft, pending or (not for employers) published; never expired or cancelled', () => {
    fc.assert(
      fc.property(status, actor, (to, who) => {
        const ok = jobTransitionProblem(null, to, who) === null
        const expected =
          who === 'employer' ? to === 'draft' || to === 'pending' : to === 'draft' || to === 'pending' || to === 'published'
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
  it('publishes now for the plan’s duration', () => {
    expect(datesForTransition({ durationDays: 30, from: 'pending', now: NOW, to: 'published' })).toEqual({
      expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
      publishedAt: NOW.toISOString(),
    })
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

const org = (approved: boolean, canPayByInvoice: boolean) => ({ approved, canPayByInvoice })

describe('decidePublication (moderation hook point, PJ-32)', () => {
  it('follows the old site’s rule by default: approved, paid or on invoice publishes', () => {
    const cases: [boolean, boolean, number, 'pending' | 'published'][] = [
      [false, false, 0, 'pending'],
      [true, false, 0, 'published'],
      [false, true, 0, 'published'],
      [false, false, 1, 'published'],
    ]
    for (const [approved, invoice, total, expected] of cases) {
      expect(decidePublication({ mode: 'legacy', orderTotal: total, organisation: org(approved, invoice) })).toBe(expected)
    }
  })

  it('reviews everything, publishes everything, or holds on an unknown mode', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.nat(), (approved, invoice, total) => {
        const organisation = org(approved, invoice)
        expect(decidePublication({ mode: 'review', orderTotal: total, organisation })).toBe('pending')
        expect(decidePublication({ mode: 'auto', orderTotal: total, organisation })).toBe('published')
        expect(decidePublication({ mode: 'weekly' as never, orderTotal: total, organisation })).toBe('pending')
      }),
    )
  })
})
