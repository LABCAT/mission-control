type FormatDateOptions = {
  locale?: string
  /** IANA timezone, from the tenant. */
  timezone?: null | string
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** `2026-02-31` rolls over to March in `Date`, so date-only values are checked field by field. */
const parseDateOnly = (value: string): Date => {
  const [, year, month, day] = DATE_ONLY.exec(value) ?? []
  const date = new Date(`${value}T00:00:00Z`)
  const sameDay =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)

  if (!sameDay) {
    throw new TypeError(`Not a valid date: ${value}`)
  }

  return date
}

/**
 * A date shown on a job, as `15 Nov 2026`. Timezone comes from the tenant.
 *
 * A date-only value (`2026-12-01`) names a calendar day, not an instant, so it keeps that day in
 * every timezone. Only timestamps are converted, otherwise a tenant west of UTC would show a
 * closing date as the day before.
 */
export const formatDate = (value: Date | number | string, options: FormatDateOptions = {}): string => {
  const dateOnly = typeof value === 'string' && DATE_ONLY.test(value)
  const date = dateOnly ? parseDateOnly(value) : value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Not a valid date: ${String(value)}`)
  }

  return new Intl.DateTimeFormat(options.locale ?? 'en', {
    day: 'numeric',
    month: 'short',
    timeZone: dateOnly ? 'UTC' : (options.timezone ?? 'UTC'),
    year: 'numeric',
  }).format(date)
}
