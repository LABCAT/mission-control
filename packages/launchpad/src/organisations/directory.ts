/**
 * The organisation directory (PJ-38). One page lists every public organisation, filtered by type
 * and size, with its current live-job count. Founder decision (18 Nov): fewer than 100
 * organisations, so no pagination; a guard keeps the page bounded all the same.
 *
 * Which organisations are public is the CMS's call: a site key only ever reads organisations the
 * collection's own rule allows (page on, not a possible duplicate, approved where the tenant
 * requires it). This module does not restate that rule, so a setting change cannot make the site
 * disagree with the CMS.
 */
import type { CmsClient } from '../cms/client'
import type { CmsCollectionSlug } from '../cms/types'
import { liveJobsWhere } from '../jobs/listing'
import { resolveLocale } from '../tenant/locale'
import type { SiteTenant } from '../tenant/types'
import type { MediaImage, OrgSummary } from '../types'

/** The most organisations one directory page draws (same ~200 guard as the jobs listing). */
export const ORGANISATION_DIRECTORY_LIMIT = 200

export const ORGANISATION_TYPE_OPTIONS = [
  { label: 'Business', value: 'business' },
  { label: 'Consultant', value: 'consultant' },
  { label: 'Government', value: 'government' },
  { label: 'Not-for-profit', value: 'nfp' },
  { label: 'Recruiter', value: 'recruiter' },
  { label: 'Social enterprise', value: 'social-enterprise' },
] as const

export const ORGANISATION_SIZE_OPTIONS = [
  { label: '1–10 people', value: '1-10' },
  { label: '11–50 people', value: '11-50' },
  { label: '51–200 people', value: '51-200' },
  { label: '201–500 people', value: '201-500' },
  { label: '500+ people', value: '500-plus' },
] as const

export type DirectoryFilters = { size?: string; type?: string }

const allowed = (options: readonly { value: string }[], value: unknown): string | undefined =>
  typeof value === 'string' && options.some((option) => option.value === value) ? value : undefined

/** The filters a query string asks for. An unknown value is ignored, never passed to the CMS. */
export const parseDirectoryFilters = (
  params: Pick<URLSearchParams, 'get'> | null | undefined,
): DirectoryFilters => {
  const type = allowed(ORGANISATION_TYPE_OPTIONS, params?.get('type'))
  const size = allowed(ORGANISATION_SIZE_OPTIONS, params?.get('size'))
  return { ...(size ? { size } : {}), ...(type ? { type } : {}) }
}

type Populated<T> = null | number | T | undefined

/** A public organisation as the directory and the profile read it. */
export type OrganisationDoc = {
  about?: null | string
  id: number | string
  location?: Populated<{ name?: null | string }>
  logo?: Populated<MediaImage>
  name?: null | string
  size?: null | string
  slug?: null | string
  type?: null | string
  website?: null | string
}

/**
 * The fields the site reads. Selecting them keeps the response to public fields even if the
 * collection grows a private one.
 */
export const ORGANISATION_SELECT = {
  about: true,
  location: true,
  logo: true,
  name: true,
  size: true,
  slug: true,
  type: true,
  website: true,
} as const

const populated = <T extends object>(value: Populated<T>): null | T =>
  value !== null && value !== undefined && typeof value === 'object' ? value : null

/** Two letters for the logo placeholder: `Vanuatu Brewing` → `VB`. */
export const initialsOf = (name: string): string => {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
  const letters = words.slice(0, 2).map((word) => Array.from(word.replace(/^[^\p{L}\p{N}]+/u, ''))[0] ?? '')
  return letters.join('').toUpperCase()
}

const labelFor = (options: readonly { label: string; value: string }[], value: null | string | undefined) =>
  options.find((option) => option.value === value)?.label

export type DirectoryEntry = OrgSummary & {
  initials: string
  sizeLabel?: string
  typeLabel?: string
}

/** The card for one organisation, or `null` when it has no name or slug (no page to link to). */
export const toDirectoryEntry = (
  doc: OrganisationDoc,
  jobCount: number,
  hrefFor: (slug: string) => string = (slug) => `/organisations/${encodeURIComponent(slug)}`,
): DirectoryEntry | null => {
  const name = doc.name?.trim()
  const slug = doc.slug?.trim()
  if (!name || !slug) return null

  const logo = populated(doc.logo)
  const location = populated(doc.location)?.name?.trim()
  const about = doc.about?.trim()
  const sizeLabel = labelFor(ORGANISATION_SIZE_OPTIONS, doc.size)
  const typeLabel = labelFor(ORGANISATION_TYPE_OPTIONS, doc.type)

  return {
    ...(about ? { description: about } : {}),
    initials: initialsOf(name),
    jobCount,
    ...(location ? { location } : {}),
    ...(logo?.url ? { logo } : {}),
    name,
    ...(sizeLabel ? { sizeLabel } : {}),
    ...(typeLabel ? { typeLabel } : {}),
    url: hrefFor(slug),
  }
}

export type OrganisationDirectory = {
  entries: DirectoryEntry[]
  filters: DirectoryFilters
  /** True when more organisations matched than the page draws. */
  truncated: boolean
}

export type LoadOrganisationDirectoryOptions = {
  cms: Pick<CmsClient, 'find' | 'findAll'>
  /** Resolved collection slugs (PJ-80). */
  collections?: { jobs?: string; organisations?: string }
  filters?: DirectoryFilters
  now?: Date
  tenant: SiteTenant
}

const organisationIDOf = (value: unknown): null | number | string => {
  if (typeof value === 'number' || typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' || typeof id === 'string') return id
  }
  return null
}

/** Live jobs per organisation id. One request for the whole directory, not one per card. */
export const countLiveJobs = (jobs: readonly { organisation?: unknown }[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const job of jobs) {
    const id = organisationIDOf(job.organisation)
    if (id !== null) counts.set(String(id), (counts.get(String(id)) ?? 0) + 1)
  }
  return counts
}

export const loadOrganisationDirectory = async ({
  cms,
  collections = {},
  filters = {},
  now = new Date(),
  tenant,
}: LoadOrganisationDirectoryOptions): Promise<OrganisationDirectory> => {
  const organisationsSlug = (collections.organisations ?? 'organisations') as CmsCollectionSlug
  const jobsSlug = (collections.jobs ?? 'jobs') as CmsCollectionSlug
  const locale = resolveLocale(tenant)

  const where = {
    and: [
      ...(filters.type ? [{ type: { equals: filters.type } }] : []),
      ...(filters.size ? [{ size: { equals: filters.size } }] : []),
    ],
  }

  const [organisations, jobs] = await Promise.all([
    // Listed regardless of live jobs (decided 19 Nov).
    cms.find(organisationsSlug, {
      depth: 1,
      limit: ORGANISATION_DIRECTORY_LIMIT + 1,
      locale,
      select: ORGANISATION_SELECT,
      sort: 'name',
      ...(where.and.length > 0 ? { where } : {}),
    }),
    cms.findAll(jobsSlug, { depth: 0, select: { organisation: true }, where: liveJobsWhere(now) }),
  ])

  const counts = countLiveJobs(jobs as unknown as { organisation?: unknown }[])
  const docs = organisations.docs as unknown as OrganisationDoc[]

  const entries = docs
    .slice(0, ORGANISATION_DIRECTORY_LIMIT)
    .map((doc) => toDirectoryEntry(doc, counts.get(String(doc.id)) ?? 0))
    .filter((entry): entry is DirectoryEntry => entry !== null)

  return { entries, filters, truncated: docs.length > ORGANISATION_DIRECTORY_LIMIT }
}
