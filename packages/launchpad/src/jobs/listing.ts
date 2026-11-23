/**
 * The job listing (`/jobs`) as data: which filters the page owns, how a filter set becomes a
 * Payload query, and how a job document becomes a `JobSummary` for the card.
 *
 * Everything here is pure except `loadJobListing`, which takes a CMS client. A page renders the
 * view that comes back; `jobListingView` builds the same view from data already in hand, so a
 * demo or a test can render a listing without a CMS.
 */
import { DEFAULT_CONTENT_VERSION, readContentVersion, type ContentVersionStore } from '@mission-control/content-cache'

import { cacheTag, cachedResponse, type CacheLike } from '../cms/cache'
import { HTML_EDGE_TTL_SECONDS } from '../cms/headers'
import type { CmsClient } from '../cms/client'
import type { CmsWhere } from '../cms/types'
import {
  cacheQueryString,
  contentCacheKey,
  readCacheQuery,
  type CacheParamRule,
} from '../tenant/cache-key'
import {
  filterQuery,
  parseFilters,
  type FilterControl,
  type FilterDefinition,
  type FilterValues,
} from '../tenant/filters'
import { resolveLocale } from '../tenant/locale'
import { resultsSummary } from '../tenant/pagination'
import type { SiteTenant } from '../tenant/types'
import type { JobSummary } from '../types'

/** A page of jobs. The CMS does the pagination; the listing never renders more than this. */
export const JOB_LISTING_PAGE_SIZE = 20

/**
 * HTML is held at the edge for five minutes when nothing can invalidate it: long enough to absorb
 * a burst, short enough to feel live. A site with a content version store uses the seven-day
 * lifetime instead, because the version, not the clock, is what refreshes the page (PJ-41).
 */
export const JOB_LISTING_HTML_TTL_SECONDS = 5 * 60

/**
 * `voluntary=1` adds voluntary jobs. They are left out by default: the archive keeps them out
 * and they have their own listing (AUDIT.md, `/jobs/type/voluntary`).
 */
export const VOLUNTARY_PARAM = 'voluntary'

/** Filters the listing owns, in the order the form shows them; `page` last so URLs stay stable. */
export const JOB_LISTING_FILTER_NAMES = ['q', 'category', 'type', 'location', VOLUNTARY_PARAM, 'page'] as const

/**
 * The controls `/jobs` shows, in order. A page renders `FilterBar` from this, so the form and the
 * query string cannot drift apart: every control is a filter the listing owns. A site app may
 * pass its own list (labels in the tenant's language, more controls) to `FilterBar` instead.
 */
export const jobFilterControls = (facets: ListingFacets): FilterControl[] => [
  { label: 'Keywords', name: 'q', placeholder: 'Job title or company', type: 'search' },
  {
    anyLabel: 'All categories',
    label: 'Category',
    name: 'category',
    options: facets.categories.map(({ name, slug }) => ({ label: name, value: slug })),
    type: 'select',
  },
  {
    anyLabel: 'All types',
    label: 'Type',
    name: 'type',
    options: facets.types.map(({ name, slug }) => ({ label: name, value: slug })),
    type: 'select',
  },
  {
    anyLabel: 'All locations',
    label: 'Location',
    name: 'location',
    options: facets.locations.map(({ name, slug }) => ({ label: name, value: slug })),
    type: 'select',
  },
  { label: 'Include voluntary jobs', name: VOLUNTARY_PARAM, type: 'checkbox', value: '1' },
]

/** A taxonomy as the listing uses it (from `findAll`, so the fields are present). */
export type ListingRef = { id: number; name: string; slug: string }
export type ListingTypeRef = ListingRef & { isVolunteer: boolean }
export type ListingLocationRef = ListingRef & { parentID: null | number }

/** The tenant's taxonomies, which both the filter controls and the query need. */
export type ListingFacets = {
  categories: ListingRef[]
  locations: ListingLocationRef[]
  types: ListingTypeRef[]
}

/**
 * The slice of a job document the listing reads. The refs are loose because a Payload document
 * may carry an unpopulated id or a null field; `toJobSummary` treats that as "not there".
 * Fetch with `depth: 2` so the refs arrive populated.
 */
export type ListingJob = {
  categories?: (null | number | { id: number; name?: null | string; slug?: null | string })[] | null
  companyName?: null | string
  displayedSalary?: null | string
  expiresAt?: null | string
  id: number | string
  jobType?: null | number | { id: number; isVolunteer?: null | boolean; name?: null | string; slug?: null | string }
  /** A job may name several locations; the card shows the first one. */
  location?:
    | null
    | number
    | { id: number; name?: null | string; slug?: null | string }
    | (null | number | { id: number; name?: null | string; slug?: null | string })[]
  organisation?: null | number | { id: number; name?: null | string; slug?: null | string }
  slug?: null | string
  title?: null | string
}

type JobOrganisationRef = { name: string; slug?: null | string }

export type ListingHrefs = {
  /** Defaults to `/jobs/${slug}` (the job page, PJ-37). */
  job?: (job: ListingJob) => string
  /** Defaults to `/organisations/${slug}` (the organisation page, PJ-38). */
  organisation?: (organisation: JobOrganisationRef) => string
}

export type JobListingView = {
  /**
   * URL the filter form submits to. On a section page this is `/jobs`: changing a control leaves
   * the section instead of half-applying it, and the value stays visible in the form.
   */
  formAction: string
  definitions: readonly FilterDefinition[]
  facets: ListingFacets
  filters: FilterValues
  /** True when a query-string filter is set; the path slug of a section page does not count. */
  hasActiveFilters: boolean
  /**
   * True when the URL asked for something this listing does not do: a taxonomy slug the tenant
   * lacks, or a page past the end. The HTML is right, but it is not the HTML that URL names, so
   * `serveJobListing` does not store it under that URL's key.
   */
  inexact: boolean
  /** Builds the href for a page of this listing; page 1 is the bare listing URL. */
  href: (page: number) => string
  jobs: JobSummary[]
  locale: string
  page: number
  pageSize: number
  /** `Showing 1–20 of 137 jobs`. */
  summary: string
  total: number
  totalPages: number
}

export type JobListingResult =
  | { found: false; reason: 'unknown-category' | 'unknown-location' | 'unknown-type' }
  | { found: true; view: JobListingView }

const refID = (value: null | number | { id: number } | undefined): null | number => {
  if (value === null || value === undefined) return null
  return typeof value === 'object' ? value.id : value
}

const populated = <T extends { id: number }>(value: null | number | T | undefined): null | T =>
  typeof value === 'object' && value !== null ? value : null

/** The filters the page validates against, built from the tenant's own taxonomy slugs. */
export const jobFilterDefinitions = (facets: ListingFacets): FilterDefinition[] => {
  const allowed: Partial<Record<(typeof JOB_LISTING_FILTER_NAMES)[number], readonly string[]>> = {
    category: facets.categories.map((category) => category.slug),
    location: facets.locations.map((location) => location.slug),
    type: facets.types.map((type) => type.slug),
    [VOLUNTARY_PARAM]: ['1'],
  }

  return JOB_LISTING_FILTER_NAMES.map((name) => ({ allowed: allowed[name], name }))
}

const idOfSlug = (refs: readonly ListingRef[], slug: null | string | undefined): null | number =>
  refs.find((ref) => ref.slug === slug)?.id ?? null

/**
 * A location filter covers its own subtree: picking an island lists its towns too. The tree is
 * parent → child (region ← island ← town); growing a list while walking it keeps the result
 * independent of the order the rows arrive in, and a cycle cannot loop forever.
 */
export const locationDescendantIDs = (
  locations: readonly ListingLocationRef[],
  slug: string,
): number[] => {
  const root = locations.find((location) => location.slug === slug)
  if (!root) return []

  const children = new Map<number, number[]>()
  for (const location of locations) {
    if (location.parentID === null) continue
    children.set(location.parentID, [...(children.get(location.parentID) ?? []), location.id])
  }

  const ids = [root.id]
  for (let index = 0; index < ids.length; index += 1) {
    for (const child of children.get(ids[index]!) ?? []) {
      if (!ids.includes(child)) ids.push(child)
    }
  }

  return ids
}

export type ListingWhereOptions = {
  facets: ListingFacets
  filters: FilterValues
  /** The clock that decides whether a job is still live. */
  now?: Date
}

/**
 * The Payload query for a filter set: jobs that are live only, meaning published and either
 * with no expiry or an expiry still ahead. That is `liveJobsWhere` in `packages/payload-jobs`;
 * expired jobs keep their own page and never appear in a listing.
 */
export const listingWhere = ({
  facets,
  filters,
  now = new Date(),
}: ListingWhereOptions): CmsWhere => {
  const and: CmsWhere[] = [
    { status: { equals: 'published' } },
    { or: [{ expiresAt: { greater_than: now.toISOString() } }, { expiresAt: { exists: false } }] },
  ]

  const keyword = filters.q?.trim()
  if (keyword) {
    // `companyName` defaults to the organisation's name (PJ-19), so this searches company too.
    and.push({ or: [{ companyName: { like: keyword } }, { title: { like: keyword } }] })
  }

  const categoryID = idOfSlug(facets.categories, filters.category)
  if (categoryID !== null) and.push({ categories: { in: [categoryID] } })

  const typeID = idOfSlug(facets.types, filters.type)
  if (typeID !== null) and.push({ jobType: { equals: typeID } })

  const locationIDs = filters.location ? locationDescendantIDs(facets.locations, filters.location) : []
  if (locationIDs.length > 0) and.push({ location: { in: locationIDs } })

  const voluntaryTypeIDs = facets.types.filter((type) => type.isVolunteer).map((type) => type.id)
  // Picking a voluntary type is an explicit request for voluntary jobs, so it never empties the
  // page. Otherwise they stay out of the listing unless `voluntary=1` asks for them.
  const wantsVoluntary = filters[VOLUNTARY_PARAM] === '1' || (typeID !== null && voluntaryTypeIDs.includes(typeID))
  if (!wantsVoluntary && voluntaryTypeIDs.length > 0) {
    // `not_in` alone would also drop a job with no type (SQL NULL), so those are kept.
    and.push({ or: [{ jobType: { not_in: voluntaryTypeIDs } }, { jobType: { exists: false } }] })
  }

  return { and }
}

/**
 * A job document as the card needs it, or `null` when it cannot be rendered: a job with no slug
 * has no page, and one with no organisation or company name has no attribution. Callers drop nulls.
 */
export const toJobSummary = (job: ListingJob, hrefs: ListingHrefs = {}): JobSummary | null => {
  const title = job.title?.trim()
  const slug = job.slug?.trim()
  const organisation = populated(job.organisation)
  const organisationName = organisation?.name?.trim() || job.companyName?.trim()
  if (!title || !slug || !organisationName) return null

  const type = populated(job.jobType)
  const location = (Array.isArray(job.location) ? job.location : [job.location])
    .map((value) => populated(value))
    .find((value) => value !== null)
  const salary = job.displayedSalary?.trim()

  const organisationUrl = hrefs.organisation
    ? hrefs.organisation({ name: organisationName, slug: organisation?.slug })
    : organisation?.slug
      ? `/organisations/${encodeURIComponent(organisation.slug)}`
      : undefined

  return {
    ...(job.expiresAt ? { closes: job.expiresAt } : {}),
    ...(salary ? { displayedSalary: salary } : {}),
    ...(type?.isVolunteer === true ? { isVolunteer: true } : {}),
    ...(type?.name ? { jobType: type.name } : {}),
    ...(location?.name ? { location: location.name } : {}),
    organisation: { name: organisationName, ...(organisationUrl ? { url: organisationUrl } : {}) },
    title,
    url: hrefs.job ? hrefs.job(job) : `/jobs/${encodeURIComponent(slug)}`,
  }
}

/**
 * The query string for a filter set: validated values sorted by name, which is the canonical order
 * the cache key and the 301 use, with the page number last. Sorting here means a link the site
 * emits is already canonical, so following it never redirects.
 */
const canonicalQuery = (
  values: FilterValues,
  definitions: readonly FilterDefinition[],
  page: number,
): string => {
  const { page: _ignored, ...rest } = values

  return cacheQueryString(Object.fromEntries(new URLSearchParams(filterQuery(rest, definitions))), page)
}

export type ListingHrefOptions = {
  basePath: string
  definitions: readonly FilterDefinition[]
  filters: FilterValues
  /** Filters fixed by the route (`category` on `/jobs/category/:slug`); not repeated in the query. */
  lockedKeys?: readonly string[]
  page: number
}

/** A page of this listing that keeps the filters, so a shared link shows the same results. */
export const listingHref = ({
  basePath,
  definitions,
  filters,
  lockedKeys = [],
  page,
}: ListingHrefOptions): string => {
  const values: FilterValues = { ...filters }
  for (const key of lockedKeys) delete values[key]

  const query = canonicalQuery(values, definitions, page)
  return query ? `${basePath}?${query}` : basePath
}

/**
 * The listing a request path asks for: `/jobs`, `/jobs/category/:slug` or `/jobs/type/:slug`
 * (with or without a trailing slash). `null` is "this is not a listing path", which the app turns
 * into its own 404. The slug is decoded, so a section with a non-ASCII slug still resolves.
 *
 * A site app dispatches with this and then calls `serveJobListing`, so no app repeats the
 * path-to-filter mapping:
 *
 * ```ts
 * const route = jobListingRoute(Astro.url.pathname)
 * if (!route) return notFound()
 * return serveJobListing({ ...route, cms, render, search: Astro.url.search, site, tenant })
 * ```
 */
export const jobListingRoute = (pathname: string): { basePath: string; locked: FilterValues } | null => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === '/jobs') return { basePath: '/jobs', locked: {} }

  const match = /^\/jobs\/(category|type)\/([^/]+)$/.exec(path)
  if (!match) return null

  const [, kind, rawSlug] = match
  let slug: string
  try {
    slug = decodeURIComponent(rawSlug!)
  } catch {
    // A malformed escape is not a section that exists.
    return null
  }
  if (!slug) return null

  const key = kind === 'category' ? 'category' : 'type'
  return { basePath: `/jobs/${kind}/${encodeURIComponent(slug)}`, locked: { [key]: slug } }
}

/** Purge tags for a site's listing HTML; PJ-41 purges the site tag and the jobs tag. */
export const jobListingCacheTags = (site: string): string[] => [
  cacheTag('site', site),
  cacheTag('site', site, 'jobs'),
]

/** What the edge cache needs for one rendered listing: where to store it and how to purge it. */
export type ListingCache = { key: string; tags: string[]; ttl: number }

export type ListingCacheOptions = {
  basePath: string
  /** Filters the path already fixes (`/jobs/category/trades`), so repeating one in the query changes nothing. */
  lockedKeys?: readonly string[]
  /** The request's raw query string; `page` included. */
  search: null | string | URLSearchParams
  site: string
  /**
   * The tenant's content version (PJ-41). A CMS write bumps it, so every data centre misses instead
   * of relying on a per-colo `purgeTags`. Defaults to `DEFAULT_CONTENT_VERSION` for a site with no
   * KV store, such as the demo.
   */
  version?: string
  /** The edge lifetime of the entry. Defaults to `JOB_LISTING_HTML_TTL_SECONDS`. */
  ttl?: number
}

export type ListingQuery = { filters: FilterValues; page: number }

/** The highest page the listing will serve. Twenty jobs a page makes this 10,000 jobs, far past any
 * real listing, so the clamp costs nothing; without it every number would be its own cache key and
 * a stranger could mint a million entries that all hold the last page.
 */
const MAX_LISTING_PAGE = 500
const MAX_KEYWORD_LENGTH = 100

/** The query parameters the listing owns, as cache-key rules. One list for the key and the query. */
export const jobListingCacheRules = (): CacheParamRule[] => [
  { kind: 'keyword', maxLength: MAX_KEYWORD_LENGTH, name: 'q' },
  { kind: 'value', name: 'category' },
  { kind: 'value', name: 'type' },
  { kind: 'value', name: 'location' },
  { kind: 'flag', name: VOLUNTARY_PARAM, value: '1' },
  { kind: 'page', max: MAX_LISTING_PAGE, name: 'page' },
]

/**
 * Read a listing request once, for both the cache key and the CMS query. Going through a single
 * function is what keeps the two from disagreeing: a filter this drops is a filter the listing
 * does not apply, and a page it clamps is the page the listing serves.
 *
 * A keyword is cut to `MAX_KEYWORD_LENGTH`, so an enormous search is still a search rather than a
 * silent "show everything". A page is clamped to `[1, MAX_LISTING_PAGE]`.
 *
 * Taxonomy membership is the one check this cannot make, because it needs the CMS. The loader
 * then drops a slug the tenant does not have, so such a URL renders the unfiltered listing under
 * its own key: correct, merely a wasted entry, and bounded by the slug shape.
 */
export const readListingQuery = (search: null | string | URLSearchParams): ListingQuery => {
  const { page, values } = readCacheQuery(search, jobListingCacheRules())

  return { filters: values, page }
}

/**
 * The edge-cache identity of a listing request: site, content version, path and the filters in the
 * URL. It is derived from the request alone, so `serveJobListing` can look the page up before it
 * queries the CMS. Two URLs that differ only in a dropped parameter (a `utm_` tag, `?page=1`) share
 * an entry; two that differ in a filter do not. The version is the same for every page of a site,
 * so bumping it misses the whole site at once (PJ-41).
 */
export const listingCache = ({
  basePath,
  lockedKeys = [],
  search,
  site,
  ttl = JOB_LISTING_HTML_TTL_SECONDS,
  version = DEFAULT_CONTENT_VERSION,
}: ListingCacheOptions): ListingCache => {
  const { filters, page } = readListingQuery(search)

  const values: FilterValues = { ...filters }
  for (const name of JOB_LISTING_FILTER_NAMES) {
    if (lockedKeys.includes(name)) delete values[name]
  }

  const query = cacheQueryString(values, page)

  return {
    key: contentCacheKey({ site, url: query ? `${basePath}?${query}` : basePath, version }),
    tags: jobListingCacheTags(site),
    ttl,
  }
}

export type JobListingViewInput = {
  basePath: string
  definitions: readonly FilterDefinition[]
  facets: ListingFacets
  filters: FilterValues
  inexact?: boolean
  /** One page of jobs, already mapped and in CMS order. */
  jobs: JobSummary[]
  locale?: string
  lockedKeys?: readonly string[]
  page: number
  pageSize?: number
  total: number
}

/** The data a listing page renders. Pure: the same input always gives the same view. */
export const jobListingView = (input: JobListingViewInput): JobListingView => {
  const pageSize = input.pageSize ?? JOB_LISTING_PAGE_SIZE
  const total = Number.isFinite(input.total) ? Math.max(0, Math.trunc(input.total)) : 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const requested = Number.isFinite(input.page) ? Math.trunc(input.page) : 1
  const page = Math.min(Math.max(requested, 1), totalPages)
  const lockedKeys = [...(input.lockedKeys ?? [])]

  const queryOnly: FilterValues = { ...input.filters }
  for (const key of [...lockedKeys, 'page']) delete queryOnly[key]

  return {
    definitions: input.definitions,
    facets: input.facets,
    filters: input.filters,
    formAction: lockedKeys.length > 0 ? '/jobs' : input.basePath,
    hasActiveFilters: Object.values(queryOnly).some((value) => value.trim() !== ''),
    inexact: input.inexact ?? false,
    href: (target: number) =>
      listingHref({
        basePath: input.basePath,
        definitions: input.definitions,
        filters: input.filters,
        lockedKeys,
        page: target,
      }),
    jobs: input.jobs,
    locale: input.locale ?? 'en',
    page,
    pageSize,
    summary: resultsSummary({ noun: 'jobs', page, pageSize, total }),
    total,
    totalPages,
  }
}

export type LoadJobListingOptions = {
  /** Needs only the read methods, so a test can pass a small fake. */
  cms: Pick<CmsClient, 'find' | 'findAll'>
  /** Where this listing lives: `/jobs`, `/jobs/category/hospitality` … */
  basePath?: string
  hrefs?: ListingHrefs
  /** Filters fixed by the route rather than the query string. */
  locked?: FilterValues
  now?: Date
  pageSize?: number
  search: null | string | URLSearchParams
  tenant: SiteTenant
}

/**
 * The tenant's taxonomies, in its own language: `name` is a localized field, so without `locale`
 * a site whose default differs from Payload's gets another locale's labels in its filter bar.
 */
const facetsOf = async (cms: LoadJobListingOptions['cms'], locale: string): Promise<ListingFacets> => {
  const query = { locale, sort: 'name' }
  const [categories, types, locations] = await Promise.all([
    cms.findAll('job-categories', query),
    cms.findAll('job-types', query),
    cms.findAll('locations', query),
  ])

  return {
    categories: categories.map(({ id, name, slug }) => ({ id, name, slug })),
    locations: locations.map(({ id, name, parent, slug }) => ({
      id,
      name,
      parentID: refID(parent),
      slug,
    })),
    types: types.map(({ id, isVolunteer, name, slug }) => ({
      id,
      isVolunteer: isVolunteer === true,
      name,
      slug,
    })),
  }
}

const unknownSection = (
  locked: FilterValues,
  facets: ListingFacets,
): JobListingResult | null => {
  if (locked.category && idOfSlug(facets.categories, locked.category) === null) {
    return { found: false, reason: 'unknown-category' }
  }
  if (locked.type && idOfSlug(facets.types, locked.type) === null) {
    return { found: false, reason: 'unknown-type' }
  }
  if (locked.location && idOfSlug(facets.locations, locked.location) === null) {
    return { found: false, reason: 'unknown-location' }
  }

  return null
}

/**
 * Load one page of the listing: the tenant's taxonomies, the query string, the jobs.
 *
 * A path slug the tenant does not have (`/jobs/category/nope`) is `found: false`, which the page
 * turns into a 404. A query-string value that is not allowed is dropped instead: a hand-edited
 * URL must not be able to filter by anything.
 */
export const loadJobListing = async (options: LoadJobListingOptions): Promise<JobListingResult> => {
  const {
    cms,
    hrefs,
    locked = {},
    now = new Date(),
    pageSize = JOB_LISTING_PAGE_SIZE,
    search,
    tenant,
  } = options
  const basePath = options.basePath ?? '/jobs'

  const locale = resolveLocale(tenant)
  const facets = await facetsOf(cms, locale)
  const definitions = jobFilterDefinitions(facets)
  // The same reading the cache key used, so the HTML stored there is the HTML this URL means.
  // `parseFilters` then drops a taxonomy slug this tenant does not have.
  const query = readListingQuery(search)
  const filters: FilterValues = {
    ...parseFilters(new URLSearchParams(query.filters), definitions),
    ...locked,
  }

  const missing = unknownSection(locked, facets)
  if (missing) return missing

  // A query filter this tenant has no value for was dropped above, so the page will not be the
  // one the URL describes. The answer is still right (an unfiltered or narrower listing), it just
  // must not be stored under a key claiming that filter. A filter the path fixes is not compared:
  // the path wins, and the cache key already leaves it out.
  const lockedKeys = Object.keys(locked)
  const inexact = Object.entries(query.filters).some(
    ([name, value]) => !lockedKeys.includes(name) && filters[name] !== value,
  )

  const where = listingWhere({ facets, filters, now })
  const sort = ['-publishedAt', '-id']
  const page = query.page

  // `locale` covers the job's localized fields: the title the card shows, and the title the
  // keyword filter matches. Both must be in the tenant's language, not Payload's default.
  const queryOptions = { depth: 2, limit: pageSize, locale, sort, where }
  let result = await cms.find('jobs', { ...queryOptions, page })
  // `?page=99` on a two-page listing: serve the last page rather than an empty one.
  if (result.docs.length === 0 && result.totalDocs > 0 && page > result.totalPages) {
    result = await cms.find('jobs', { ...queryOptions, page: result.totalPages })
  }

  const jobs = result.docs
    .map((doc) => toJobSummary(doc, hrefs))
    .filter((job): job is JobSummary => job !== null)

  return {
    found: true,
    view: jobListingView({
      basePath,
      definitions,
      facets,
      filters,
      inexact: inexact || result.page !== page,
      jobs,
      locale,
      lockedKeys: Object.keys(locked),
      page: result.page,
      pageSize,
      total: result.totalDocs,
    }),
  }
}

export type ServeJobListingOptions = LoadJobListingOptions & {
  /** Defaults to `caches.default`; with no cache the page is rendered on every request. */
  cache?: CacheLike
  /** Renders the page for a view. The site app passes Astro's `render`. */
  render: (view: JobListingView) => Promise<Response>
  /** The tenant slug; scopes the cache key and the purge tags. */
  site: string
  /** The tenant's content version store (KV in production). Absent means version `0`. */
  store?: ContentVersionStore
  /**
   * The version already read for this request. A site that renders several cached pages from one
   * request reads the version once and passes it here.
   */
  version?: string
}

/**
 * The whole SSR listing in one call: load the view, render it, and hold the HTML at the edge under
 * the site's content version (PJ-41).
 *
 * The edge lifetime is seven days when a version store exists, because the version, not the clock,
 * is what refreshes the page; five minutes without one, because then nothing can invalidate the
 * entry and its TTL is the only way a change reaches the site.
 *
 * A missing section is a 404 and is not cached: a slug that does not exist must not be stored as
 * "not found" for days after the taxonomy gains it.
 */
export const serveJobListing = async (options: ServeJobListingOptions): Promise<Response> => {
  const { cache, render, store, version, ...loadOptions } = options
  const contentVersion = version ?? (await readContentVersion(store, loadOptions.site))
  // The key comes from the request, so a hit is answered without touching the CMS.
  const { key, tags, ttl } = listingCache({
    basePath: loadOptions.basePath ?? '/jobs',
    lockedKeys: Object.keys(loadOptions.locked ?? {}),
    search: loadOptions.search,
    site: loadOptions.site,
    ttl: store || version ? HTML_EDGE_TTL_SECONDS : JOB_LISTING_HTML_TTL_SECONDS,
    version: contentVersion,
  })

  return cachedResponse(
    key,
    ttl,
    async () => {
      const result = await loadJobListing(loadOptions)

      if (!result.found) {
        return new Response(notFoundBody(result.reason), {
          headers: { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
          status: 404,
        })
      }

      const response = await render(result.view)
      if (!result.view.inexact) return response

      // The URL promised a filter or a page this listing does not have, so its HTML does not
      // belong to its key: `?category=made-up-a` and `?category=made-up-b` both render the
      // unfiltered listing, and storing each would waste an entry per made-up slug.
      const headers = new Headers(response.headers)
      headers.set('cache-control', 'no-store')
      return new Response(response.body, { headers, status: response.status })
    },
    { cache, tags },
  )
}

/** A section slug the tenant does not have is a URL that does not exist, not an empty listing. */
const NOT_FOUND_REASONS: Record<Extract<JobListingResult, { found: false }>['reason'], string> = {
  'unknown-category': 'There is no such job category.',
  'unknown-location': 'There is no such location.',
  'unknown-type': 'There is no such job type.',
}

const notFoundBody = (reason: keyof typeof NOT_FOUND_REASONS): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title>` +
  `<meta name="robots" content="noindex"></head>` +
  `<body><h1>Not found</h1><p>${NOT_FOUND_REASONS[reason]}</p></body></html>`
