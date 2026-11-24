/**
 * The organisation page at `/organisations/{slug}` (PJ-38): the profile and the organisation's own
 * live jobs. A private, unapproved or possible-duplicate organisation is not readable with the
 * site key, so the CMS answers "not found" and so does the page: the 404 and the missing document
 * agree, and a private page cannot be probed by slug.
 */
import type { CmsClient } from '../cms/client'
import type { CmsCollectionSlug } from '../cms/types'
import {
  featuredFirst,
  liveJobsWhere,
  toJobSummary,
  type ListingJob,
} from '../jobs/listing'
import { resolveLocale } from '../tenant/locale'
import type { SiteTenant } from '../tenant/types'
import type { JobSummary, MediaImage } from '../types'
import {
  initialsOf,
  ORGANISATION_SELECT,
  ORGANISATION_SIZE_OPTIONS,
  ORGANISATION_TYPE_OPTIONS,
  type OrganisationDoc,
} from './directory'

export type OrganisationProfile = {
  about?: string
  initials: string
  jobs: JobSummary[]
  location?: string
  logo?: MediaImage
  name: string
  /** The SEO tab's meta description, when it sets one (PJ-104). */
  seoDescription?: string
  /** Present and true when the SEO tab asks search engines to skip the profile (PJ-104). */
  seoNoIndex?: true
  /** The SEO tab's browser title, when it sets one (PJ-104). */
  seoTitle?: string
  sizeLabel?: string
  slug: string
  typeLabel?: string
  website?: string
}

export type LoadOrganisationProfileOptions = {
  cms: Pick<CmsClient, 'find' | 'findBySlug'>
  collections?: { jobs?: string; organisations?: string }
  now?: Date
  slug: string
  tenant: SiteTenant
}

/** Only a web address is linked: an editor-typed `javascript:` value is dropped. */
const safeWebsite = (value: null | string | undefined): string | undefined => {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  try {
    const url = new URL(trimmed)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export type OrganisationPageResult =
  | { kind: 'found'; profile: OrganisationProfile }
  | { kind: 'not-found' }

export const loadOrganisationProfile = async ({
  cms,
  collections = {},
  now = new Date(),
  slug,
  tenant,
}: LoadOrganisationProfileOptions): Promise<OrganisationPageResult> => {
  const clean = slug.trim()
  if (!clean) return { kind: 'not-found' }

  const locale = resolveLocale(tenant)
  const organisationsSlug = (collections.organisations ?? 'organisations') as CmsCollectionSlug
  const jobsSlug = (collections.jobs ?? 'jobs') as CmsCollectionSlug

  const doc = (await cms.findBySlug(organisationsSlug, clean, {
    depth: 1,
    locale,
    select: ORGANISATION_SELECT,
  })) as unknown as null | OrganisationDoc

  const name = doc?.name?.trim()
  if (!doc || !name) return { kind: 'not-found' }

  // Only this organisation's own jobs: a possible duplicate has its own id, so its jobs never
  // reach this query, and they move here only when the organisations are merged.
  const result = await cms.find(jobsSlug, {
    depth: 2,
    limit: 100,
    locale,
    sort: ['-publishedAt', '-id'],
    where: { and: [...(liveJobsWhere(now).and ?? []), { organisation: { equals: doc.id } }] },
  })

  const jobs = featuredFirst(
    result.docs
      .map((job) => toJobSummary(job as unknown as ListingJob, {}, now))
      .filter((job): job is JobSummary => job !== null),
    { featured: (job) => job.featured === true },
  )

  const logo = typeof doc.logo === 'object' && doc.logo !== null && doc.logo.url ? doc.logo : undefined
  const location =
    typeof doc.location === 'object' && doc.location !== null ? doc.location.name?.trim() : undefined
  const about = doc.about?.trim()
  const website = safeWebsite(doc.website)
  const sizeLabel = ORGANISATION_SIZE_OPTIONS.find((option) => option.value === doc.size)?.label
  const typeLabel = ORGANISATION_TYPE_OPTIONS.find((option) => option.value === doc.type)?.label
  const seoDescription = doc.seo?.description?.trim()
  const seoTitle = doc.seo?.title?.trim()

  return {
    kind: 'found',
    profile: {
      ...(about ? { about } : {}),
      initials: initialsOf(name),
      jobs,
      ...(location ? { location } : {}),
      ...(logo ? { logo } : {}),
      name,
      ...(seoDescription ? { seoDescription } : {}),
      ...(doc.seo?.noIndex === true ? { seoNoIndex: true as const } : {}),
      ...(seoTitle ? { seoTitle } : {}),
      ...(sizeLabel ? { sizeLabel } : {}),
      slug: doc.slug?.trim() || clean,
      ...(typeLabel ? { typeLabel } : {}),
      ...(website ? { website } : {}),
    },
  }
}
