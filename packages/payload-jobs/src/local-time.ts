/**
 * Calendar dates in a tenant's timezone. A job's listing duration is counted in the tenant's own
 * days (PJ-32), so "45 days from today" means the end of a local day, not 45 × 24 hours: a
 * publication that would otherwise end at 09:00 on a workday ends when that day does.
 *
 * Pure: no clock, no database. `Intl` supplies the zone rules, including daylight saving.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** The zone's IANA name, or `UTC` for a missing or unknown one. */
export const validTimeZone = (timeZone: unknown): string => {
  if (typeof timeZone !== 'string' || !timeZone) return 'UTC'
  try {
    return Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

/** The calendar date (`YYYY-MM-DD`) of `instant` in `timeZone`. */
export const localDateOf = (instant: number, timeZone: string): string =>
  new Intl.DateTimeFormat('en-CA', { day: '2-digit', month: '2-digit', timeZone, year: 'numeric' }).format(
    new Date(instant),
  )

/** How far `timeZone` is ahead of UTC at `instant`, in ms (whole seconds). */
const offsetAt = (instant: number, timeZone: string): number => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      second: 'numeric',
      timeZone,
      year: 'numeric',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUTC - Math.floor(instant / 1000) * 1000
}

/** The last millisecond of `date` (`YYYY-MM-DD`) in `timeZone`, as an ISO instant. */
export const endOfLocalDay = (date: string, timeZone: string): string => {
  const [year, month, day] = date.split('-').map(Number)
  const guess = Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  let result = guess - offsetAt(guess, timeZone)
  // Across a DST change the offset at the answer can differ from the offset at the guess.
  const second = guess - offsetAt(result, timeZone)
  if (second !== result) result = second
  return new Date(result).toISOString()
}

/** `date` (`YYYY-MM-DD`) moved by whole calendar days, so DST never shifts the count. */
export const addLocalDays = (date: string, days: number): string => {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

/** The end of the local day `days` days after `instant`, in the tenant's timezone. */
export const endOfLocalDayAfter = (instant: number, days: number, timeZone: string): string =>
  endOfLocalDay(addLocalDays(localDateOf(instant, timeZone), days), timeZone)

export { DAY_MS }
