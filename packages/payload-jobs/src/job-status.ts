import type { Where } from 'payload'

/**
 * The job lifecycle, as a small state machine (pure: no database, no clock of its own).
 *
 *   draft ──► pending ──► published ──► expired
 *     │  ◄──    │             │            │
 *     │         │             ▼            │ relist (publishedAt resets)
 *     └────► cancelled ◄──────┘     published ◄┘
 *
 * - `draft`: the employer is still writing it.
 * - `pending`: submitted, waiting for checkout or moderation (PJ-31, PJ-32).
 * - `published`: live until `expiresAt`.
 * - `expired`: ended (time ran out, or ended early). Still readable, never listed.
 * - `cancelled`: withdrawn for good.
 *
 * Employers move their own jobs between draft and pending, or cancel them. Publishing, expiring
 * and relisting are for staff and for system code (checkout, the hourly expiry), which act with
 * `overrideAccess` and no user.
 */

export const JOB_STATUSES = ['draft', 'pending', 'published', 'expired', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  cancelled: 'Cancelled',
  draft: 'Draft',
  expired: 'Expired',
  pending: 'Pending',
  published: 'Published',
}

/** Every allowed move. Anything else, including staying put with a different meaning, is refused. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  cancelled: [],
  draft: ['pending', 'published', 'cancelled'],
  expired: ['published'],
  pending: ['draft', 'published', 'cancelled'],
  published: ['expired', 'cancelled'],
}

/** The statuses a new job may start in. Expired and cancelled jobs are never created. */
export const JOB_INITIAL_STATUSES: readonly JobStatus[] = ['draft', 'pending', 'published']

/** Who is acting: an employer on their own job, staff, or system code (no user). */
export type JobActor = 'employer' | 'staff' | 'system'

/** What an employer may do themselves; the rest goes through checkout or staff. */
const EMPLOYER_MOVES: readonly (readonly [JobStatus, JobStatus])[] = [
  ['draft', 'pending'],
  ['pending', 'draft'],
  ['draft', 'cancelled'],
  ['pending', 'cancelled'],
]

/** The statuses an employer may create a job in. */
export const EMPLOYER_INITIAL_STATUSES: readonly JobStatus[] = ['draft', 'pending']

/** The statuses in which an employer may still edit their own job. */
export const EMPLOYER_EDITABLE_STATUSES: readonly JobStatus[] = ['draft', 'pending']

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

const DAY_MS = 24 * 60 * 60 * 1000

/** The dates a job gets when its status changes. */
export type JobStatusDates = { expiresAt?: null | string; publishedAt?: null | string }

/**
 * The date fields to set alongside a status change, at `now`:
 * - published (from draft or pending): `publishedAt` = now, `expiresAt` = now + the listing
 *   duration. Without a duration the expiry is left as it is (staff set it by hand).
 * - published again from expired (relist): the same, so `publishedAt` resets.
 * - expired early (before `expiresAt`): `expiresAt` = now, so the record says when it ended.
 * - anything else: no date changes.
 *
 * PJ-32 replaces the plain day count with the tenant's timezone rule.
 */
export const datesForTransition = ({
  durationDays,
  expiresAt,
  from,
  now,
  to,
}: {
  durationDays?: null | number
  expiresAt?: null | string
  from: JobStatus | null
  now: Date
  to: JobStatus
}): JobStatusDates => {
  if (to === 'published' && from !== 'published') {
    const publishedAt = now.toISOString()
    if (!Number.isSafeInteger(durationDays) || (durationDays as number) < 1) return { publishedAt }
    return { expiresAt: new Date(now.getTime() + (durationDays as number) * DAY_MS).toISOString(), publishedAt }
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

/**
 * Moderation: what happens to a job after checkout (PJ-32 calls this; it decides, it doesn't
 * write). Configured per tenant (`jobModeration`):
 * - `legacy` (the old site's rule, the default): publish straight away if the organisation is
 *   approved, or the order cost more than 0, or the organisation pays by invoice; otherwise
 *   wait for an admin.
 * - `review`: every job waits for an admin.
 * - `auto`: every job publishes straight away.
 */
export const JOB_MODERATION_MODES = ['legacy', 'review', 'auto'] as const
export type JobModerationMode = (typeof JOB_MODERATION_MODES)[number]

export const decidePublication = ({
  mode,
  organisation,
  orderTotal,
}: {
  mode: JobModerationMode
  organisation: { approved?: boolean | null; canPayByInvoice?: boolean | null }
  orderTotal: number
}): 'pending' | 'published' => {
  switch (mode) {
    case 'auto':
      return 'published'
    case 'review':
      return 'pending'
    case 'legacy':
      return organisation.approved === true || orderTotal > 0 || organisation.canPayByInvoice === true
        ? 'published'
        : 'pending'
    default:
      // An unknown mode is a configuration error; holding the job for review is the safe side.
      return 'pending'
  }
}
