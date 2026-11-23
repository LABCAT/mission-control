/**
 * The job detail page (`/jobs/{slug}`) as data (PJ-37): which document the path names, what the
 * page shows, and whether the page is live, closed or gone. The mapping is pure, so a test or the
 * demo can build a page without a CMS.
 *
 * Rules, all from the tenant's settings:
 *
 * - A live job is indexable and carries `JobPosting` structured data.
 * - An expired job (decision 17) is HTTP 200 with a notice, no apply button, similar live jobs,
 *   `noindex` and no structured data. After `expiredJobGoneAfterMonths` it is 410 Gone.
 * - `expiredJobMode: 'gone'` answers 410 the moment the job expires (the legacy behaviour).
 */
import type { CmsClient } from '../cms/client'
import {
  tenantJobPageSettings,
  type ExpiredJobMode,
  type TenantJobPageSettings,
  type TenantJobPageSource,
} from '../tenant/job-page-settings'
import { resolveLocale } from '../tenant/locale'
import { jobPostingStructuredData, type JobPostingStructuredData } from '../tenant/seo'
import type { SiteTenant } from '../tenant/types'
import type { JobSummary } from '../types'
import { liveJobsWhere, toJobSummary, type ListingJob } from './listing'

/** Where a job page lives. The slug is unique per tenant (PJ-19). */
export const jobDetailPath = (slug: string): string => `/jobs/${encodeURIComponent(slug)}`

/**
 * The slug a job page path names, or `null` for any other path. A trailing slash is the same
 * page, so `/jobs/chef/` resolves; the slug is decoded so a non-ASCII one still works.
 */
export const jobDetailRoute = (pathname: string): null | string => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const match = /^\/jobs\/([^/]+)$/.exec(path)
  if (!match) return null

  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

export type JobPageStatus = 'expired' | 'gone' | 'live'

export type JobPageStateOptions = {
  /** The clock the page decides with. */
  now?: Date
  settings: { expiredJobMode: ExpiredJobMode; goneAfterMonths: null | number }
  status?: null | string
  expiresAt?: null | string
}

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

/**
 * What to answer for a job document.
 *
 * - `live`: published and not past its expiry.
 * - `expired`: published, past its expiry, and the tenant keeps the page (200 + notice).
 * - `gone`: never published, cancelled, or expired long enough (or the tenant answers at once).
 * - `unavailable`: the document is not there; the site answers its own 404.
 *
 * A job with no expiry stays live while published: nothing has closed it.
 */
export const jobPageState = ({
  expiresAt,
  now = new Date(),
  settings,
  status,
}: JobPageStateOptions): JobPageStatus => {
  // The CMS closes a job by setting its status to `expired` (a site key reads `published` and
  // `expired` jobs), so that status is a closed job, not a missing one. Anything else a site key
  // could see is not a page.
  if (status !== 'published' && status !== 'expired') return 'gone'

  const time = now.getTime()
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
  if (Number.isNaN(expiry)) {
    // No usable expiry: a published job stays live; an expired one has no date to count the 410
    // window from, so it keeps its notice rather than vanishing.
    if (status === 'published') return 'live'
    return settings.expiredJobMode === 'gone' ? 'gone' : 'expired'
  }
  // The status is the CMS's word that the job closed, even if its date is still ahead (an
  // early close by an admin), so only a published job can be live.
  if (status === 'published' && expiry > time) return 'live'
  if (status === 'expired' && expiry > time) return settings.expiredJobMode === 'gone' ? 'gone' : 'expired'
  if (settings.expiredJobMode === 'gone') return 'gone'

  // A null month count is the tenant's "never turn it into a Gone page".
  if (settings.goneAfterMonths === null) return 'expired'

  return time > expiry + settings.goneAfterMonths * MONTH_MS ? 'gone' : 'expired'
}

/** The slice of a job document the detail page reads; refs may be ids or populated documents. */
export type DetailJobRef = { id?: number | string; name?: null | string; slug?: null | string }

export type DetailJobOrganisation = DetailJobRef & {
  /** `pageEnabled` and `approved` decide whether the organisation has a public page. */
  approved?: null | boolean
  pageEnabled?: null | boolean
  type?: null | string
}

export type DetailJobFile = { filename?: null | string; url?: null | string }

export type DetailJob = {
  categories?: (DetailJobRef | null | number)[] | null
  companyName?: null | string
  description?: unknown
  displayedSalary?: null | string
  expiresAt?: null | string
  howToApply?: null | string
  id: number | string
  jobDescriptionPdf?: DetailJobFile | null | number
  jobType?: DetailJobRef | null | number
  location?: DetailJobRef | (DetailJobRef | null | number)[] | null
  locationDetails?: null | string
  organisation?: DetailJobOrganisation | null | number
  publishedAt?: null | string
  salaryBand?: DetailJobRef | null | number
  slug?: null | string
  status?: null | string
  /** The tenant document, populated by the detail query, so the page needs no second request. */
  tenant?: (SiteTenant & TenantJobPageSource) | null | number
  title?: null | string
}

export type JobDetail = {
  categories: string[]
  /** ISO date of the closing date, for display in the tenant's timezone. */
  closes?: string
  /** Sanitised? No: the CMS's own rich text, already HTML. */
  descriptionHtml?: string
  displayedSalary?: string
  howToApply?: string
  id: number | string
  jobType?: string
  location?: string
  /** Free-text address line, e.g. a street or "Multiple locations". */
  locationDetails?: string
  organisation: { name: string; url?: string }
  pdf?: { filename?: string; url: string }
  postedAt?: string
  salaryBand?: string
  slug: string
  title: string
  url: string
}

const populated = <T>(
  value: null | number | T | undefined,
): null | T => (typeof value === 'object' && value !== null ? value : null)

const nameOf = (value: null | number | DetailJobRef | undefined): string | undefined =>
  populated(value)?.name?.trim() || undefined

const textOf = (value: null | string | undefined): string | undefined => value?.trim() || undefined

export type HrefOptions = {
  /**
   * `/organisations/{slug}` on this site. The organisation card links only when the organisation
   * has a public page: `approved` and `pageEnabled`, both defaults to off (PJ-18).
   */
  organisation?: (organisation: { name: string; slug: string }) => string
}

/** An organisation's page exists only when it is approved and its page is switched on. */
export const organisationPagePath = (
  organisation: Pick<DetailJobOrganisation, 'approved' | 'pageEnabled' | 'slug'>,
): null | string => {
  if (organisation.approved !== true || organisation.pageEnabled !== true) return null
  const slug = organisation.slug?.trim()

  return slug ? `/organisations/${encodeURIComponent(slug)}` : null
}

/**
 * A job document as the detail page renders it, or `null` when it cannot be shown: no title or
 * no slug means no page, and no organisation or company name means nobody to attribute it to.
 * `descriptionHtml` is passed in because converting Lexical needs the editor package, which the
 * theme does not depend on.
 */
export const toJobDetail = (
  job: DetailJob,
  { descriptionHtml, ...hrefs }: HrefOptions & { descriptionHtml?: null | string } = {},
): JobDetail | null => {
  const title = job.title?.trim()
  const slug = job.slug?.trim()
  const organisation = populated(job.organisation)
  const organisationName = organisation?.name?.trim() || job.companyName?.trim()
  if (!title || !slug || !organisationName) return null

  const locations = (Array.isArray(job.location) ? job.location : [job.location])
    .map((value) => nameOf(value))
    .filter((value): value is string => Boolean(value))

  const pagePath = organisation ? organisationPagePath(organisation) : null
  const organisationUrl =
    organisation && pagePath
      ? hrefs.organisation
        ? hrefs.organisation({ name: organisationName, slug: pagePath.split('/').pop()! })
        : pagePath
      : undefined

  const pdf = populated(job.jobDescriptionPdf)
  const pdfUrl = pdf?.url?.trim()

  return {
    categories: (job.categories ?? [])
      .map((value) => nameOf(value))
      .filter((value): value is string => Boolean(value)),
    ...(job.expiresAt ? { closes: job.expiresAt } : {}),
    ...(textOf(descriptionHtml ?? undefined) ? { descriptionHtml: descriptionHtml!.trim() } : {}),
    ...(textOf(job.displayedSalary) ? { displayedSalary: job.displayedSalary!.trim() } : {}),
    ...(textOf(job.howToApply) ? { howToApply: job.howToApply!.trim() } : {}),
    id: job.id,
    ...(nameOf(job.jobType) ? { jobType: nameOf(job.jobType)! } : {}),
    ...(locations.length > 0 ? { location: locations.join(', ') } : {}),
    ...(textOf(job.locationDetails) ? { locationDetails: job.locationDetails!.trim() } : {}),
    organisation: { name: organisationName, ...(organisationUrl ? { url: organisationUrl } : {}) },
    ...(pdfUrl ? { pdf: { ...(pdf?.filename ? { filename: pdf.filename } : {}), url: pdfUrl } } : {}),
    ...(job.publishedAt ? { postedAt: job.publishedAt } : {}),
    ...(nameOf(job.salaryBand) ? { salaryBand: nameOf(job.salaryBand)! } : {}),
    slug,
    title,
    url: jobDetailPath(slug),
  }
}

/**
 * schema.org employment types for the tenant's job types. The tenant names its own types, so the
 * mapping is by slug and an unmapped type is left out rather than guessed: a wrong
 * `employmentType` is worse than none.
 */
export const EMPLOYMENT_TYPES: Readonly<Record<string, string>> = {
  'casual': 'OTHER',
  'contract': 'CONTRACTOR',
  'contractor': 'CONTRACTOR',
  'fixed-term': 'TEMPORARY',
  'full-time': 'FULL_TIME',
  'internship': 'INTERN',
  'part-time': 'PART_TIME',
  'permanent': 'FULL_TIME',
  'temporary': 'TEMPORARY',
  'voluntary': 'VOLUNTEER',
}

export type JobPostingInput = {
  detail: JobDetail
  /** The job type's slug, which picks the schema.org employment type. */
  jobTypeSlug?: null | string
  /** Absolute site origin, so `sameAs` and the address are absolute. */
  siteUrl?: null | string
  /** The tenant the job belongs to. Not used yet; kept so a caller need not change later. */
  tenant?: SiteTenant
}

/**
 * The `JobPosting` JSON-LD for a live job, or `null` for an expired or missing one: an expired
 * listing must not tell a search engine the job is open.
 */
export const jobPageJsonLd = ({
  detail,
  jobTypeSlug,
  siteUrl,
}: JobPostingInput): JobPostingStructuredData | null => {
  const description = detail.descriptionHtml?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

  return jobPostingStructuredData({
    datePosted: detail.postedAt,
    description: description || undefined,
    employmentType: jobTypeSlug ? EMPLOYMENT_TYPES[jobTypeSlug] : undefined,
    location: detail.location,
    organisationName: detail.organisation.name,
    organisationUrl: detail.organisation.url
      ? new URL(detail.organisation.url, (siteUrl ?? '').trim() || 'http://localhost').toString()
      : undefined,
    title: detail.title,
    validThrough: detail.closes,
  })
}

export type JobDetailView = {
  detail: JobDetail
  jsonLd?: JobPostingStructuredData
  /** The tenant's public view counter is on and the page is live. */
  showViews: boolean
  /** `notice`: show the "No longer accepting applications" banner. */
  expired: boolean
  /** Live jobs shown under a closed one. */
  similar: JobSummary[]
  status: 'expired' | 'live'
  /** The tenant the job belongs to, settings and branding included. */
  tenant: SiteTenant & TenantJobPageSource
  /** Title for the document: the job and the organisation. */
  title: string
}

export type JobDetailPageInput = {
  detail: JobDetail
  settings: TenantJobPageSettings
  status: Exclude<JobPageStatus, 'unavailable'>
  /** Live jobs to show under a closed one; the loader fills this for expired pages. */
  similar?: JobSummary[]
  tenant: SiteTenant
  siteUrl?: null | string
  jobTypeSlug?: null | string
}

/**
 * What the page renders. A live job is indexable and carries `JobPosting`; a closed one shows the
 * notice, drops the structured data (strictly no `JobPosting` for an expired date) and lists
 * similar live jobs instead of the apply section.
 */
export const jobDetailView = ({
  detail,
  jobTypeSlug,
  settings,
  similar = [],
  siteUrl,
  status,
  tenant,
}: JobDetailPageInput): JobDetailView => {
  const live = status === 'live'

  return {
    detail,
    ...(live ? { jsonLd: jobPageJsonLd({ detail, jobTypeSlug, siteUrl }) ?? undefined } : {}),
    expired: !live,
    showViews: live && settings.publicJobViews,
    similar: live ? [] : similar,
    status: live ? 'live' : 'expired',
    tenant,
    title: `${detail.title} at ${detail.organisation.name}`,
  }
}

/**
 * The tenant a job page renders for: the job's own tenant document, over the site's fallback.
 * The detail query populates `tenant`, so the page reads settings, currency, timezone and
 * branding without a second request; the fallback covers a job whose tenant is not populated
 * (a demo, a depth-0 response) and the site's own branding.
 */
export const tenantOfJob = (
  job: Pick<DetailJob, 'tenant'>,
  fallback: SiteTenant & TenantJobPageSource,
): SiteTenant & TenantJobPageSource => {
  const jobTenant = populated(job.tenant)
  if (!jobTenant) return fallback

  const { branding, ...rest } = jobTenant

  return {
    ...fallback,
    ...(rest as SiteTenant & TenantJobPageSource),
    // A tenant row may carry only some branding; the site's own is the base either way.
    branding: branding ? { ...fallback.branding, ...branding } : fallback.branding,
    name: rest.name?.trim() || fallback.name,
  }
}

/** How many live jobs sit under a closed one. Enough to be useful, short of a second listing. */
export const SIMILAR_JOB_LIMIT = 3

export type LoadJobDetailOptions = {
  cms: Pick<CmsClient, 'find' | 'findBySlug'>
  /** The job's rich text, as HTML. The site passes the CMS editor's converter. */
  descriptionHtml?: (description: unknown) => string
  now?: Date
  /** Absolute origin, for the canonical `sameAs` in the structured data. */
  siteUrl?: null | string
  slug: string
  /** The tenant document, which carries the page settings. */
  tenant: SiteTenant & TenantJobPageSource
}

export type JobDetailResult =
  | { found: false }
  /** `gone`: the site answers 410 and shows its own page. */
  | { found: true; status: 'gone' }
  | { found: true; status: 'expired' | 'live'; view: JobDetailView }

/** The detail-page query: refs populated so the page needs no second request. */
const DETAIL_DEPTH = 2

/**
 * Load one job page: the document, its state, and (for a closed job) a few live jobs like it.
 *
 * The CMS access rule already limits a site key to its tenant's published and expired jobs, so a
 * draft or another tenant's job simply is not there. `gone` is the site's 410, and `found: false`
 * its 404.
 */
export const loadJobDetail = async (options: LoadJobDetailOptions): Promise<JobDetailResult> => {
  const { cms, descriptionHtml, now = new Date(), siteUrl, slug } = options
  const locale = resolveLocale(options.tenant)

  const doc = (await cms.findBySlug('jobs', slug, { depth: DETAIL_DEPTH, locale })) as DetailJob | null
  if (!doc) return { found: false }

  const tenant = tenantOfJob(doc, options.tenant)
  const settings = tenantJobPageSettings(tenant)

  const detail = toJobDetail(doc, {
    descriptionHtml: descriptionHtml ? descriptionHtml(doc.description) : undefined,
  })
  if (!detail) return { found: false }

  const status = jobPageState({ expiresAt: doc.expiresAt, now, settings, status: doc.status })
  if (status === 'gone') return { found: true, status }

  const similar =
    status === 'expired'
      ? await similarJobs({ cms, detail, locale, now })
      : []

  return {
    found: true,
    status,
    view: jobDetailView({
      detail,
      jobTypeSlug: populated(doc.jobType)?.slug,
      settings,
      similar,
      siteUrl,
      status,
      tenant,
    }),
  }
}

type SimilarJobsOptions = {
  cms: LoadJobDetailOptions['cms']
  detail: JobDetail
  locale: string
  now: Date
}

/**
 * A few live jobs for a closed one: same categories first, then the newest. The closed job is
 * left out by id, because a job can be its own category match.
 */
const similarJobs = async ({ cms, detail, locale, now }: SimilarJobsOptions): Promise<JobSummary[]> => {
  const live = liveJobsWhere(now)
  const wanted = SIMILAR_JOB_LIMIT + 1

  const byCategory = detail.categories.length
    ? await cms.find('jobs', {
        depth: 2,
        limit: wanted,
        locale,
        sort: ['-publishedAt', '-id'],
        where: { and: [live, { categories: { in: detail.categories } }] },
      })
    : null

  // The closed job can match its own query (same category, or a stale row in the CMS), so it is
  // removed by both identities a card can carry: its id and its URL.
  const keysOf = (id: unknown, url: string): string[] => [
    ...(id === null || id === undefined ? [] : [`id:${String(id)}`]),
    `url:${url}`,
  ]
  const seen = new Set<string>(keysOf(detail.id, detail.url))
  const found: JobSummary[] = []
  const collect = (docs: unknown[]): void => {
    for (const raw of docs) {
      if (found.length >= SIMILAR_JOB_LIMIT) return
      const summary = toJobSummary(raw as ListingJob)
      if (!summary) continue
      const keys = keysOf(summary.id, summary.url)
      if (keys.some((key) => seen.has(key))) continue
      for (const key of keys) seen.add(key)
      found.push(summary)
    }
  }

  collect(byCategory?.docs ?? [])

  if (found.length < SIMILAR_JOB_LIMIT) {
    const latest = await cms.find('jobs', {
      depth: 2,
      limit: wanted,
      locale,
      sort: ['-publishedAt', '-id'],
      where: live,
    })
    collect(latest.docs)
  }

  return found
}

