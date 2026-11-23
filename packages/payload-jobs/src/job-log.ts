import type { CollectionBeforeChangeHook, Field } from 'payload'

import { hasAnyTenantRole, hasTenantRole, isSuperAdmin, type MissionControlUser } from './access'
import { JOB_STATUSES, isJobStatus, type JobStatus } from './job-status'

/**
 * A job's status log: every move, oldest first, nobody can edit it (PJ-32). The organisation
 * History reads it (PJ-24), so a job that was approved, relisted and ended early shows each
 * step, not just where it ended up.
 */

export const JOB_LOG_FIELD = 'log'

export const JOB_LOG_EVENTS = ['created', 'status'] as const
export type JobLogEvent = (typeof JOB_LOG_EVENTS)[number]

export const JOB_LOG_ACTORS = ['employer', 'staff', 'system'] as const
export type JobLogActor = (typeof JOB_LOG_ACTORS)[number]

export type JobLogEntry = {
  actor: JobLogActor
  at: string
  /** The signed-in user, when there was one. */
  by: null | number | string
  event: JobLogEvent
  from: null | JobStatus
  note: null | string
  to: JobStatus
}

const noWrite = () => false

/** The log field, shared by the jobs collection. */
export const jobLogField = (usersSlug: string): Field => ({
  name: JOB_LOG_FIELD,
  type: 'array',
  access: { create: noWrite, update: noWrite },
  admin: { description: 'Every status change, oldest first. Nobody can edit it.', readOnly: true },
  fields: [
    {
      type: 'row',
      fields: [
        { name: 'at', type: 'date', required: true, admin: { date: { pickerAppearance: 'dayAndTime' } } },
        {
          name: 'event',
          type: 'select',
          options: JOB_LOG_EVENTS.map((value) => ({ label: value, value })),
          required: true,
        },
        {
          name: 'actor',
          type: 'select',
          options: JOB_LOG_ACTORS.map((value) => ({ label: value, value })),
          required: true,
        },
        { name: 'by', type: 'relationship', relationTo: usersSlug },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'from',
          type: 'select',
          options: JOB_STATUSES.map((value) => ({ label: value, value })),
        },
        {
          name: 'to',
          type: 'select',
          options: JOB_STATUSES.map((value) => ({ label: value, value })),
          required: true,
        },
        { name: 'note', type: 'text' },
      ],
    },
  ],
})

/** `req.context` key that carries the note a site manager's action wants in the log. */
export const JOB_LOG_NOTE_CONTEXT = 'jobLogNote'

const storedLog = (value: unknown): JobLogEntry[] =>
  Array.isArray(value) ? (value as JobLogEntry[]).filter((entry) => entry && typeof entry === 'object') : []

/**
 * Append a log entry when the status changes (and one when a job is created), and keep the
 * stored entries: the field is append-only, so a write that drops or edits one is a mistake.
 * Runs after `jobStatusRules`, which has already validated the move and set the dates.
 */
export const jobStatusLog =
  (): CollectionBeforeChangeHook =>
  ({ context, data, operation, originalDoc, req }) => {
    const previous = storedLog(originalDoc?.[JOB_LOG_FIELD])
    const to = (data?.status ?? originalDoc?.status) as JobStatus
    if (!isJobStatus(to)) return data

    if (operation === 'create') {
      const note = typeof context?.[JOB_LOG_NOTE_CONTEXT] === 'string' ? context[JOB_LOG_NOTE_CONTEXT] : null
      return {
        ...data,
        [JOB_LOG_FIELD]: [
          ...previous,
          { actor: actorFor(req), at: new Date().toISOString(), by: userIDOf(req), event: 'created', from: null, note, to },
        ],
      }
    }

    const from = (originalDoc?.status ?? null) as JobStatus | null
    if (from === to) return previous.length === 0 ? data : { ...data, [JOB_LOG_FIELD]: previous }

    const note = typeof context?.[JOB_LOG_NOTE_CONTEXT] === 'string' ? context[JOB_LOG_NOTE_CONTEXT] : null
    return {
      ...data,
      [JOB_LOG_FIELD]: [
        ...previous,
        { actor: actorFor(req), at: new Date().toISOString(), by: userIDOf(req), event: 'status', from, note, to },
      ],
    }
  }

const actorFor = (req: { user?: unknown }): JobLogActor => {
  const user = (req.user ?? null) as MissionControlUser | null
  if (!user) return 'system'
  if (isSuperAdmin(user)) return 'staff'
  return hasAnyTenantRole(user, ['tenant-admin', 'editor']) ? 'staff' : 'employer'
}

const userIDOf = (req: { user?: unknown }): null | number | string => {
  const id = (req.user as { id?: unknown } | null | undefined)?.id
  return typeof id === 'number' || typeof id === 'string' ? id : null
}
