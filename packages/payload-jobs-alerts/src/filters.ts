export const KEYWORDS_MAX_LENGTH = 200

/** Keywords are one space-separated phrase; matching is case-insensitive in PJ-48. */
export const normalizeAlertKeywords = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const keywords = value.trim().replace(/\s+/g, ' ')

  return keywords === '' ? null : keywords
}

/**
 * An alert is a saved listing filter (PJ-47): exactly what the listing pages filter on, no
 * recommendations. The input has the listing's own parameter names (`q`, `category`, `type`,
 * `location`), so the "Get these jobs by email" form can post what the page is already showing.
 */

export const ALERT_FILTER_NAMES = ['q', 'category', 'type', 'location'] as const
export type AlertFilterName = (typeof ALERT_FILTER_NAMES)[number]
export type AlertFilterValues = Partial<Record<AlertFilterName, string>>

const SLUG_MAX_LENGTH = 200

/** A filter value is a trimmed string; slugs are lowercase, keywords keep their case. */
export const normaliseAlertFilterInput = (input: unknown): AlertFilterValues => {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const values: AlertFilterValues = {}

  const keywords = normalizeAlertKeywords(source.q)
  if (keywords) {
    if (keywords.length > KEYWORDS_MAX_LENGTH) {
      throw new RangeError(`The keywords can be at most ${KEYWORDS_MAX_LENGTH} characters`)
    }
    values.q = keywords
  }

  for (const name of ['category', 'type', 'location'] as const) {
    const raw = source[name]
    if (typeof raw !== 'string') continue
    const slug = raw.trim().toLowerCase()
    if (!slug) continue
    if (slug.length > SLUG_MAX_LENGTH) throw new RangeError(`The ${name} is too long`)
    values[name] = slug
  }

  return values
}

/** The filters as a listing query string, in the listing's own order. */
export const alertQueryString = (values: AlertFilterValues): string => {
  const params = new URLSearchParams()

  for (const name of ALERT_FILTER_NAMES) {
    const value = values[name]
    if (value) params.set(name, value)
  }

  return params.toString()
}

type IDLike = number | string | { id?: number | string }

const idOf = (value: IDLike): string => String(typeof value === 'object' ? (value.id ?? '') : value)

const idsKey = (values: IDLike[] | null | undefined): string =>
  [...new Set((values ?? []).map(idOf).filter(Boolean))].sort().join(',')

/**
 * The identity of a search: the same filters give the same key however they were typed, so two
 * alerts of one address are duplicates exactly when this matches. Empty means "every job".
 */
export const alertFilterKey = (filters: {
  categories?: IDLike[] | null
  keywords?: null | string
  locations?: IDLike[] | null
  types?: IDLike[] | null
}): string => {
  const keywords = normalizeAlertKeywords(filters.keywords)?.toLowerCase() ?? ''
  const categories = idsKey(filters.categories)
  const types = idsKey(filters.types)
  const locations = idsKey(filters.locations)

  if (!keywords && !categories && !types && !locations) return ''

  return `q=${keywords}|c=${categories}|t=${types}|l=${locations}`
}

const EMAIL_MAX_LENGTH = 254
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/

/** The stored form of an address, or `null` when it cannot be one. */
export const normaliseSubscriberEmail = (value: unknown): null | string => {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()

  if (email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) return null
  if (email.indexOf('@') !== email.lastIndexOf('@')) return null

  return email
}

/** Throwaway-inbox providers. A tenant can extend the list; this is only the common ones. */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  '10minutemail.com',
  'discard.email',
  'dispostable.com',
  'fakeinbox.com',
  'getairmail.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'mohmal.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'tempmailo.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]

export const isDisposableEmail = (email: string, extraDomains: readonly string[] = []): boolean => {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase()
  const blocked = [...DISPOSABLE_EMAIL_DOMAINS, ...extraDomains.map((entry) => entry.trim().toLowerCase())]

  return blocked.some((entry) => entry && (domain === entry || domain.endsWith(`.${entry}`)))
}
