import type { Where } from 'payload'

import { endOfLocalDayAfter, validTimeZone } from './local-time'

/**
 * The job lifecycle, as a small state machine (pure: no database, no clock of its own).
 *
 *   draft ──► waiting_for_purchase ──► pending ──► published ──► expired
 *     │              │  ▲                │            │            │
 *     │              │  └────────────────┘            ▼            │ relist
 *     └──────────────┴──────► cancelled ◄─────────────┘   published ◄┘
 *
 * - `draft`: the employer is still writing it.
 * - `waiting_for_purchase`: submitted, but the order waits for the organisation owner (PJ-31).
 * - `pending`: submitted, waiting for a site manager's approval (PJ-32).
 * - `published`: live until `expiresAt`.
 * - `expired`: ended (time ran out, or ended early). Still readable, never listed.
 * - `cancelled`: withdrawn for good.
 *
 * Employers move their own jobs between draft, pending and waiting-for-purchase, or cancel them.
 * Publishing, expiring and relisting are for staff and for system code (checkout, the Approve
 * action, the hourly expiry), which act with `overrideAccess`.
 */

export const JOB_STATUSES = [
  'draft',
  'waiting_for_purchase',
  'pending',
  'published',
  'expired',
  'cancelled',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  cancelled: 'Cancelled',
  draft: 'Draft',
  expired: 'Expired',
  pending: 'Pending',
  published: 'Published',
  waiting_for_purchase: 'Waiting for purchase',
}

/** Every allowed move. Anything else, including staying put with a different meaning, is refused. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  cancelled: [],
  draft: ['waiting_for_purchase', 'pending', 'published', 'cancelled'],
  expired: ['published'],
  pending: ['draft', 'published', 'cancelled'],
  published: ['expired', 'cancelled'],
  waiting_for_purchase: ['cancelled', 'pending', 'published'],
}

/** The statuses a new job may start in. Expired and cancelled jobs are never created. */
export const JOB_INITIAL_STATUSES: readonly JobStatus[] = [
  'draft',
  'pending',
  'published',
  'waiting_for_purchase',
]

/** Who is acting: an employer on their own job, staff, or system code (no user). */
export type JobActor = 'employer' | 'staff' | 'system'

/** What an employer may do themselves; the rest goes through checkout, approval or staff. */
const EMPLOYER_MOVES: readonly (readonly [JobStatus, JobStatus])[] = [
  ['draft', 'pending'],
  ['pending', 'draft'],
  ['draft', 'cancelled'],
  ['pending', 'cancelled'],
  ['waiting_for_purchase', 'cancelled'],
]

/** The statuses an employer may create a job in. */
export const EMPLOYER_INITIAL_STATUSES: readonly JobStatus[] = ['draft', 'pending']

/** The statuses in which an employer may still edit their own job. */
export const EMPLOYER_EDITABLE_STATUSES: readonly JobStatus[] = ['draft', 'pending']

/** The statuses in which a job is submitted but not live yet (PJ-31, PJ-32). */
export const HELD_JOB_STATUSES: readonly JobStatus[] = ['waiting_for_purchase', 'pending']

export const isJobStatus = (value: unknown): value is JobStatus =>
  typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value)

export const canTransition = (from: JobStatus, to: JobStatus): boolean => JOB_TRANSITIONS[from].includes(to)

/**
 * Why a status change is refused, or `null` when it is allowed. `from` is `null` for a new job.
 * Saving a job without changing its status is always allowed (other rules decide the rest).
 */
export const jobTransitionProblem = (
  from: JobStatus | null,
  to: JobStatus,
  actor: JobActor,
): null | string => {
  if (!isJobStatus(to)) return `"${String(to)}" is not a job status`

  if (from === null) {
    if (!JOB_INITIAL_STATUSES.includes(to)) return `A new job can't start as ${to}`
    if (actor === 'employer' && !EMPLOYER_INITIAL_STATUSES.includes(to)) {
      return 'A new job starts as a draft or pending; it is published at checkout'
    }
    return null
  }

  if (from === to) return null
  if (!canTransition(from, to)) return `A ${from} job can't become ${to}`
  if (actor === 'employer' && !EMPLOYER_MOVES.some(([a, b]) => a === from && b === to)) {
    return `Only staff or checkout can move a job from ${from} to ${to}`
  }
  return null
}

/** The dates a job gets when its status changes. */
export type JobStatusDates = { expiresAt?: null | string; publishedAt?: null | string }

/**
 * The date fields to set alongside a status change, at `now`:
 * - published (from draft, pending, waiting-for-purchase or expired): `publishedAt` = now, and
 *   `expiresAt` = the end of the local day `durationDays` days later in the tenant's timezone,
 *   or the close date chosen at checkout (PJ-31) when that is earlier and still ahead. Without a
 *   duration the expiry is left as it is (staff set it by hand).
 * - expired early (before `expiresAt`): `expiresAt` = now, so the record says when it ended.
 * - anything else: no date changes.
 */
export const datesForTransition = ({
  durationDays,
  expiresAt,
  from,
  now,
  timeZone,
  to,
}: {
  durationDays?: null | number
  expiresAt?: null | string
  from: JobStatus | null
  now: Date
  timeZone?: null | string
  to: JobStatus
}): JobStatusDates => {
  if (to === 'published' && from !== 'published') {
    const publishedAt = now.toISOString()
    if (!Number.isSafeInteger(durationDays) || (durationDays as number) < 1) return { publishedAt }
    const latest = endOfLocalDayAfter(now.getTime(), durationDays as number, validTimeZone(timeZone))
    // The close date the employer chose at checkout (PJ-31) is kept when it is still ahead, but
    // never past the plan's duration from now. A relist (from expired) always starts afresh.
    const chosen = from !== 'expired' && expiresAt ? Date.parse(expiresAt) : Number.NaN
    const ends =
      Number.isFinite(chosen) && chosen > now.getTime() ? Math.min(chosen, Date.parse(latest)) : Date.parse(latest)
    return { expiresAt: new Date(ends).toISOString(), publishedAt }
  }

  if (to === 'expired' && from === 'published') {
    const ends = expiresAt ? Date.parse(expiresAt) : Number.NaN
    if (!Number.isFinite(ends) || ends > now.getTime()) return { expiresAt: now.toISOString() }
  }

  return {}
}

/** The statuses the public may read: live jobs and ended ones (job pages stay up). */
export const PUBLIC_JOB_STATUSES: readonly JobStatus[] = ['published', 'expired']

export const PUBLIC_JOB_FILTER: Where = { status: { in: [...PUBLIC_JOB_STATUSES] } }

/**
 * Jobs that are live at `now`: published and not past their expiry (a job with no expiry yet
 * counts as live). Listings, search, the sitemap and alerts use this; expired jobs stay
 * readable on their own page but never appear in them.
 */
export const liveJobsWhere = (now: Date = new Date()): Where => ({
  and: [
    { status: { equals: 'published' } },
    { or: [{ expiresAt: { greater_than: now.toISOString() } }, { expiresAt: { exists: false } }] },
  ],
})

/** The same rule as `liveJobsWhere`, for a job already in hand. */
export const isLiveJob = (
  job: { expiresAt?: null | string; status?: null | string },
  now: Date = new Date(),
): boolean => {
  if (job.status !== 'published') return false
  if (job.expiresAt === null || job.expiresAt === undefined) return true
  return Date.parse(job.expiresAt) > now.getTime()
}
