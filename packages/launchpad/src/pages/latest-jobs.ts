/**
 * The latest-jobs block (PJ-39). The home page's layout names it, and the block renders jobs;
 * this module loads them.
 *
 * Founder decision (19 Nov): featured jobs come first, then every other live job, newest first,
 * with no pagination on the vwok MVP. The `limit` in the block is the guard: it keeps a page
 * bounded even if a tenant accumulates thousands of jobs.
 */
import type { CmsClient } from '../cms/client'
import type { CmsCollectionSlug } from '../cms/types'
import {
  featuredFirst,
  liveJobsWhere,
  toJobSummary,
  type ListingHrefs,
  type ListingJob,
} from '../jobs/listing'
import { resolveLocale } from '../tenant/locale'
import type { SiteTenant } from '../tenant/types'
import type { JobSummary } from '../types'

/** How many jobs the block shows when it does not say. */
export const LATEST_JOBS_LIMIT = 10

/** The most a single block may ask for: a page must stay bounded for the Lighthouse budget. */
export const LATEST_JOBS_MAX_LIMIT = 50

/** The block's own `limit`, clamped: a missing, negative or huge value still yields a bounded page. */
export const latestJobsLimit = (value: unknown): number => {
  const requested = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(requested) || requested <= 0) return LATEST_JOBS_LIMIT
  return Math.min(Math.trunc(requested), LATEST_JOBS_MAX_LIMIT)
}

export type LoadLatestJobsOptions = {
  cms: Pick<CmsClient, 'find'>
  /** The jobs collection's resolved slug (PJ-80). */
  collection?: string
  hrefs?: ListingHrefs
  /** The block's configured limit. */
  limit?: unknown
  now?: Date
  tenant: SiteTenant
}

export type LatestJobsResult = {
  /** Featured first, then newest first. */
  jobs: JobSummary[]
  /** True when the query hit the CMS limit, so the block is a slice, not the whole board. */
  truncated: boolean
}

/**
 * Load the jobs the latest-jobs block shows. `depth: 2` populates the organisation and the job
 * type, which the card reads; the jobs come back `-publishedAt`, so a stable sort that lifts the
 * featured jobs gives "featured first, newest first".
 */
export const loadLatestJobs = async ({
  cms,
  collection = 'jobs',
  hrefs,
  limit,
  now = new Date(),
  tenant,
}: LoadLatestJobsOptions): Promise<LatestJobsResult> => {
  const locale = resolveLocale(tenant)
  const size = latestJobsLimit(limit)

  const result = await cms.find(collection as CmsCollectionSlug, {
    depth: 2,
    limit: size,
    locale,
    sort: ['-publishedAt', '-id'],
    where: liveJobsWhere(now),
  })

  const summaries = result.docs
    .map((doc) => toJobSummary(doc as unknown as ListingJob, hrefs, now))
    .filter((job): job is JobSummary => job !== null)

  return {
    jobs: featuredFirst(summaries, { featured: (job) => job.featured === true }),
    truncated: result.totalDocs > summaries.length,
  }
}
