/**
 * Validators shared by the job-board collections. They stay pure so the admin, the local
 * API and the tests all apply the same rules. Payload calls a validator with the field value
 * and a context object; only the value matters here.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const GA4_MEASUREMENT_ID = /^G-[A-Z0-9]{4,20}$/
const CLOUDFLARE_ANALYTICS_TOKEN = /^[0-9a-f]{32}$/
const ABSOLUTE_URL = /^https?:\/\/[^\s]+$/i
// A protocol-relative `//host` is excluded: it silently points at another site.
const RELATIVE_URL = /^\/(?!\/)[^\s]*$/

export const MAX_SLUG_LENGTH = 120

/** Lowercase, ASCII, single-hyphen slug from a title. `About Us!` becomes `about-us`. */
export const slugifyTitle = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')

export const isValidPageSlug = (value: string): boolean =>
  value.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(value)

export const validatePageSlug = (value: null | string | undefined): string | true => {
  if (!value) return 'Slug is required'

  return isValidPageSlug(value)
    ? true
    : 'Use lowercase letters, numbers and single hyphens, for example about-us'
}

/**
 * A site reports to one analytics provider. GA4 measurement IDs and Cloudflare Web Analytics
 * tokens are the two supported forms, so a typo is caught in the admin instead of silently
 * collecting nothing.
 */
export const validateAnalyticsId = (value: null | string | undefined): string | true => {
  const trimmed = value?.trim()
  if (!trimmed) return true

  return GA4_MEASUREMENT_ID.test(trimmed) || CLOUDFLARE_ANALYTICS_TOKEN.test(trimmed)
    ? true
    : 'Use a GA4 measurement ID (G-XXXXXXXXXX) or a Cloudflare Web Analytics token'
}

/** Site links are either a path on the tenant's site or an absolute http(s) URL. */
export const validateLinkHref = (value: null | string | undefined): string | true => {
  const trimmed = value?.trim()
  if (!trimmed) return true

  if (RELATIVE_URL.test(trimmed) || ABSOLUTE_URL.test(trimmed)) return true

  return 'Use a path starting with / or a full http(s) URL'
}
