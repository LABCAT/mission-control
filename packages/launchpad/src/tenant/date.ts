type FormatDateOptions = {
  locale?: string
  /** IANA timezone, from the tenant. */
  timezone?: null | string
}

/** A date shown on a job, as `15 Nov 2026`. Timezone comes from the tenant. */
export const formatDate = (value: Date | number | string, options: FormatDateOptions = {}): string => {
  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Not a valid date: ${String(value)}`)
  }

  return new Intl.DateTimeFormat(options.locale ?? 'en', {
    day: 'numeric',
    month: 'short',
    timeZone: options.timezone ?? 'UTC',
    year: 'numeric',
  }).format(date)
}
