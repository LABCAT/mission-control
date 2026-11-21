/**
 * Date ranges in the tenant's own timezone (PJ-53). `from` and `to` are calendar days
 * (`YYYY-MM-DD`), both inclusive: the range is [start of `from`, start of the day after `to`).
 */

export const DAY = /^\d{4}-\d{2}-\d{2}$/

const parts = (instant: number, timeZone: string) => {
  const map: Record<string, number> = {}
  for (const part of new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') map[part.type] = Number(part.value)
  }
  return map
}

/** Minutes the zone is ahead of UTC at `instant`. */
const offsetMs = (instant: number, timeZone: string): number => {
  const p = parts(instant, timeZone)
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(instant / 1000) * 1000
}

export const isValidTimeZone = (value: unknown): value is string => {
  if (typeof value !== 'string' || value === '') return false
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone !== ''
  } catch {
    return false
  }
}

/** True when `value` is a real calendar day (rejects 2026-02-31). */
export const isCalendarDay = (value: string): boolean => {
  if (!DAY.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y!, m! - 1, d!))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
}

/** The instant (ms) a calendar day starts in `timeZone`. */
export const startOfDay = (day: string, timeZone: string): number => {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y!, m! - 1, d!)
  let instant = guess - offsetMs(guess, timeZone)
  instant = guess - offsetMs(instant, timeZone)
  return instant
}

const nextDay = (day: string): string => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10)
}

export type ResolvedRange = { end?: string; start?: string }

/** ISO bounds for a query: `created >= start` and `created < end`. Throws a message on bad input. */
export const resolveRange = (from: string | undefined, to: string | undefined, timeZone: string): ResolvedRange => {
  if (from !== undefined && !isCalendarDay(from)) throw new RangeError('`from` must be a date like 2026-03-01')
  if (to !== undefined && !isCalendarDay(to)) throw new RangeError('`to` must be a date like 2026-03-31')
  if (from !== undefined && to !== undefined && from > to) throw new RangeError('`from` must not be after `to`')

  return {
    end: to === undefined ? undefined : new Date(startOfDay(nextDay(to), timeZone)).toISOString(),
    start: from === undefined ? undefined : new Date(startOfDay(from, timeZone)).toISOString(),
  }
}

/** `YYYY-MM` of an instant in the tenant's timezone. */
export const monthOf = (value: unknown, timeZone: string): string => {
  const time = new Date(String(value)).getTime()
  if (Number.isNaN(time)) return ''
  const p = parts(time, timeZone)
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}
