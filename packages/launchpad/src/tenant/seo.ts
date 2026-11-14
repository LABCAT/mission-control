export type SeoMeta = {
  canonical: string
  description?: string
  noindex: boolean
  title: string
}

export type SeoInput = {
  /** Absolute site origin from the tenant, e.g. `https://vanuatuwok.vu`. */
  siteUrl?: null | string
  /** Path of the current page, e.g. `/jobs/123`. Defaults to `/`. */
  path?: null | string
  title: string
  description?: null | string
  /** Search results, filtered listings and error pages stay out of the index. */
  noindex?: boolean
}

/**
 * A canonical URL ends in `/` (except the root) so a page can't be reached under two URLs,
 * and any query string is dropped: filters and search are noindex, so they canonicalise to
 * the unfiltered page.
 */
export const canonicalUrl = (
  siteUrl: null | string | undefined,
  path: null | string | undefined,
): string => {
  const base = (siteUrl ?? '').trim().replace(/\/+$/, '')
  const rawPath = (path ?? '/').split(/[?#]/)[0] ?? '/'
  const normalised = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  const trimmed = normalised.replace(/\/+$/, '')

  return `${base}${trimmed === '' ? '/' : `${trimmed}/`}`
}

export const seoMeta = (input: SeoInput): SeoMeta => {
  const description = input.description?.trim()

  return {
    canonical: canonicalUrl(input.siteUrl, input.path),
    ...(description ? { description } : {}),
    noindex: input.noindex === true,
    title: input.title.trim(),
  }
}

/** The JSON-LD `JobPosting` shape used on a job page. Optional fields are omitted. */
export type JobPostingStructuredData = {
  '@context': 'https://schema.org'
  '@type': 'JobPosting'
  datePosted?: string
  description?: string
  employmentType?: string
  hiringOrganization: { '@type': 'Organization'; name: string; sameAs?: string }
  jobLocation?: {
    '@type': 'Place'
    address: { '@type': 'PostalAddress'; addressCountry?: string; addressLocality?: string }
  }
  title: string
  validThrough?: string
}

export const jobPostingStructuredData = (posting: {
  countryCode?: null | string
  datePosted?: null | string
  description?: null | string
  employmentType?: null | string
  location?: null | string
  organisationName: string
  organisationUrl?: null | string
  title: string
  validThrough?: null | string
}): JobPostingStructuredData => {
  const data: JobPostingStructuredData = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    hiringOrganization: {
      '@type': 'Organization',
      name: posting.organisationName,
      ...(posting.organisationUrl ? { sameAs: posting.organisationUrl } : {}),
    },
    title: posting.title,
  }

  if (posting.datePosted) data.datePosted = posting.datePosted
  if (posting.validThrough) data.validThrough = posting.validThrough
  if (posting.description) data.description = posting.description
  if (posting.employmentType) data.employmentType = posting.employmentType

  if (posting.location) {
    data.jobLocation = {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        addressLocality: posting.location,
        ...(posting.countryCode ? { addressCountry: posting.countryCode } : {}),
      },
    }
  }

  return data
}
