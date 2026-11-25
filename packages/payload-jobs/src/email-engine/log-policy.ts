import { addMonths } from '../retention'

/**
 * Email log retention (PJ-50, decision 19 Nov): the recipient address is visible for 90 days,
 * then masked (j***@example.com); the row is deleted after 12 months. Both periods are
 * per-tenant settings. The log never holds a body or an attachment.
 */

export const DEFAULT_LOG_VISIBLE_DAYS = 90
export const DEFAULT_LOG_DELETE_MONTHS = 12

const DAY_MS = 24 * 60 * 60 * 1000

export type LogRetention = { deleteMonths: number; visibleDays: number }

const wholeNumber = (value: unknown): null | number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null

/**
 * The tenant's periods. A missing or malformed value takes the default: a bad setting must
 * never shorten how long a row is kept. The visible period is capped at the delete period (30
 * days per month), because a row cannot be masked after it has been deleted.
 */
export const logRetention = (
  source: { emailLogRetention?: { deleteMonths?: unknown; visibleDays?: unknown } | null } | null | undefined,
): LogRetention => {
  const deleteMonths = wholeNumber(source?.emailLogRetention?.deleteMonths) ?? DEFAULT_LOG_DELETE_MONTHS
  const visibleDays = wholeNumber(source?.emailLogRetention?.visibleDays) ?? DEFAULT_LOG_VISIBLE_DAYS

  return { deleteMonths, visibleDays: Math.min(visibleDays, deleteMonths * 31) }
}

/** Rows sent at or before `maskBefore` are masked; at or before `deleteBefore`, deleted. */
export const logCutoffs = (
  retention: LogRetention,
  now: Date,
): { deleteBefore: Date; maskBefore: Date } => ({
  deleteBefore: addMonths(now, -retention.deleteMonths),
  maskBefore: new Date(now.getTime() - retention.visibleDays * DAY_MS),
})

const ADDRESS = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/

/** `jane@example.com` becomes `j***@example.com`. Anything else becomes `***`. */
export const maskEmail = (address: string): string => {
  const match = ADDRESS.exec(address.trim())
  if (!match) return '***'
  const [, local, domain] = match as unknown as [string, string, string]
  // Already masked: leave it alone, so a repeated run changes nothing.
  if (/^(.\*{3}|\*)$/.test(local)) return `${local}@${domain}`

  return local.length === 1 ? `*@${domain}` : `${[...local][0]}***@${domain}`
}

/** The half-open UTC range of a `YYYY-MM` month. */
export const monthRange = (month: string): { from: Date; to: Date } => {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) throw new Error(`Expected a month like 2026-11, got "${month}"`)
  const year = Number(match[1])
  const index = Number(match[2]) - 1

  return { from: new Date(Date.UTC(year, index, 1)), to: new Date(Date.UTC(year, index + 1, 1)) }
}
