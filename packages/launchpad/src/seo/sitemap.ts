/**
 * The sitemap as data: which URLs a site may hand to a crawler, and the XML that carries them.
 *
 * The rules come from the migration decisions (STATUS.md, 18/19 Nov):
 *
 * - only live jobs, never expired ones, and only indexable pages;
 * - a filter page is listed only while it has jobs. An empty one answers 200 with `noindex`,
 *   so listing it would advertise a page the site itself asks crawlers to skip;
 * - query-string filter pages are never listed.
 *
 * Everything here is pure. `./serve` fetches the documents; a site app only says where its
 * pages live.
 */
import { canonicalUrl } from '../tenant/seo'

/** One URL in the sitemap. `path` is site-relative; the absolute URL is built from the origin. */
export type SitemapEntry = {
  lastModified?: null | string
  path: string
}

/** Google's per-file limit is 50,000 URLs; the margin keeps the shard count stable as a site grows. */
export const SITEMAP_MAX_URLS = 45_000

/** Shard files for a large sitemap: `/sitemap-1.xml`, `/sitemap-2.xml` … */
export const sitemapShardPath = (shard: number): string => `/sitemap-${shard}.xml`

/**
 * How a filter page's path is built. Defaults to the routes `jobListingRoute` serves today. A
 * site passes its own builders when its routes differ, and a kind with no builder is not listed
 * at all: the sitemap must never name a URL the site cannot answer.
 *
 * The founder's clean URLs (`/jobs/{location}/{category}` and friends, STATUS.md 19 Nov) are
 * routes PJ-42 adds. vwok passes `cleanFilterPaths` below once they exist; until then the
 * location pages are left out rather than advertised as 404s.
 */
export type FilterPaths = {
  category?: (slug: string) => string
  location?: (slug: string) => string
  'location-category'?: (location: string, category: string) => string
  type?: (slug: string) => string
}

const encode = (slug: string): string => encodeURIComponent(slug)

/** The listing routes `jobListingRoute` serves: `/jobs/category/{slug}` and `/jobs/type/{slug}`. */
export const defaultFilterPaths: FilterPaths = {
  category: (slug) => `/jobs/category/${encode(slug)}`,
  type: (slug) => `/jobs/type/${encode(slug)}`,
}

/** The clean, one-level URLs the founder decided on; a site passes these once it serves them. */
export const cleanFilterPaths: FilterPaths = {
  category: (slug) => `/jobs/${encode(slug)}`,
  location: (slug) => `/jobs/${encode(slug)}`,
  'location-category': (location, category) => `/jobs/${encode(location)}/${encode(category)}`,
  type: (slug) => `/jobs/${encode(slug)}`,
}

export type SitemapRef = { id: number; slug: string }
export type SitemapTypeRef = SitemapRef & { isVolunteer?: null | boolean }
/** A location as the sitemap reads it: the tree is all it needs, not the display name. */
export type SitemapLocationRef = SitemapRef & { parentID: null | number }

/** The tenant's taxonomies. */
export type SitemapFacets = {
  categories: SitemapRef[]
  locations: SitemapLocationRef[]
  types: SitemapTypeRef[]
}

/** A live job as the sitemap reads it. */
export type SitemapJob = {
  categories?: (null | number | { id: number })[] | null
  jobType?: null | number | { id: number }
  location?: (null | number | { id: number })[] | null
  slug?: null | string
  updatedAt?: null | string
}

export type SitemapPage = {
  id?: number
  parent?: null | number | { id: number }
  role?: null | string
  slug?: null | string
  updatedAt?: null | string
}

export type SitemapOrganisation = {
  slug?: null | string
  updatedAt?: null | string
}

export type SitemapSources = {
  facets: SitemapFacets
  filterPaths?: FilterPaths
  jobs: SitemapJob[]
  organisations: SitemapOrganisation[]
  pages: SitemapPage[]
}

const refIDs = (
  value: null | number | { id: number } | (null | number | { id: number })[] | undefined,
): number[] => {
  const list = Array.isArray(value) ? value : [value]
  const ids: number[] = []

  for (const item of list) {
    const id = typeof item === 'object' && item !== null ? item.id : item
    if (typeof id === 'number' && !ids.includes(id)) ids.push(id)
  }

  return ids
}

/** Counts of the jobs each filter page would show, one key per taxonomy id (or pair). */
export type FilterCounts = {
  byCategory: Map<number, number>
  byLocation: Map<number, number>
  'location-category': Map<string, number>
  byType: Map<number, number>
}

const locationKey = (locationID: number, categoryID: number): string => `${locationID}:${categoryID}`

/**
 * A job's place and every place above it: a job in Port Vila appears on the Port Vila page, the
 * Efate page and the Vanuatu page. The listing gets the same set by querying a location's
 * subtree; walking up from the job gives the identical pages with one walk per job.
 */
export const locationAncestorIDs = (
  locations: readonly SitemapLocationRef[],
  locationID: number,
): number[] => {
  const byID = new Map(locations.map((location) => [location.id, location]))
  const ids: number[] = []
  const seen = new Set<number>()
  let current = byID.get(locationID)

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    ids.push(current.id)
    current = current.parentID === null ? undefined : byID.get(current.parentID)
  }

  return ids
}

/**
 * How many jobs each filter page would show, worked out from the live jobs themselves.
 *
 * A location page covers its whole subtree, so an island counts its towns' jobs too. Jobs of a
 * type marked `listed separately` (the Volunteer type on Vanuatu Wok) are left out of every
 * other listing — that is `listingWhere`'s default — so a category or location page whose only
 * jobs are voluntary is empty, and stays out of the sitemap.
 */
export const filterCounts = ({
  facets,
  jobs,
}: {
  facets: SitemapFacets
  jobs: SitemapJob[]
}): FilterCounts => {
  const counts: FilterCounts = {
    byCategory: new Map(),
    byLocation: new Map(),
    'location-category': new Map(),
    byType: new Map(),
  }
  const separateTypeIDs = facets.types.filter((type) => type.isVolunteer === true).map((type) => type.id)

  for (const job of jobs) {
    const typeIDs = refIDs(job.jobType)
    for (const typeID of typeIDs) counts.byType.set(typeID, (counts.byType.get(typeID) ?? 0) + 1)

    // A page that lists everything (a category or a location) hides the separately listed types.
    if (typeIDs.some((id) => separateTypeIDs.includes(id))) continue

    const categoryIDs = refIDs(job.categories)
    for (const categoryID of categoryIDs) {
      counts.byCategory.set(categoryID, (counts.byCategory.get(categoryID) ?? 0) + 1)
    }

    const countedLocations = new Set<number>()
    const countedPairs = new Set<string>()
    for (const locationID of refIDs(job.location)) {
      for (const ancestorID of locationAncestorIDs(facets.locations, locationID)) {
        if (!countedLocations.has(ancestorID)) {
          countedLocations.add(ancestorID)
          counts.byLocation.set(ancestorID, (counts.byLocation.get(ancestorID) ?? 0) + 1)
        }

        // A location+category page needs one job matching both, counted once however many of the
        // job's places sit under the same location.
        for (const categoryID of categoryIDs) {
          const key = locationKey(ancestorID, categoryID)
          if (countedPairs.has(key)) continue
          countedPairs.add(key)
          counts['location-category'].set(key, (counts['location-category'].get(key) ?? 0) + 1)
        }
      }
    }
  }

  return counts
}

/**
 * The filter pages worth indexing: each one with at least one job, in taxonomy order so a shard
 * holds the same URLs from one build to the next.
 */
export const filterSitemapEntries = ({
  facets,
  filterPaths = defaultFilterPaths,
  jobs,
}: {
  facets: SitemapFacets
  filterPaths?: FilterPaths
  jobs: SitemapJob[]
}): SitemapEntry[] => {
  const counts = filterCounts({ facets, jobs })
  const entries: SitemapEntry[] = []

  if (filterPaths.category) {
    const build = filterPaths.category
    for (const category of facets.categories) {
      if ((counts.byCategory.get(category.id) ?? 0) > 0) entries.push({ path: build(category.slug) })
    }
  }

  if (filterPaths.location) {
    const build = filterPaths.location
    for (const location of facets.locations) {
      if ((counts.byLocation.get(location.id) ?? 0) > 0) entries.push({ path: build(location.slug) })
    }
  }

  if (filterPaths.type) {
    const build = filterPaths.type
    for (const type of facets.types) {
      if ((counts.byType.get(type.id) ?? 0) > 0) entries.push({ path: build(type.slug) })
    }
  }

  if (filterPaths['location-category']) {
    const build = filterPaths['location-category']
    for (const location of facets.locations) {
      for (const category of facets.categories) {
        if ((counts['location-category'].get(locationKey(location.id, category.id)) ?? 0) > 0) {
          entries.push({ path: build(location.slug, category.slug) })
        }
      }
    }
  }

  return entries
}

/** Live jobs that have a page: a job with no slug has no URL to list. */
export const jobSitemapEntries = (jobs: SitemapJob[]): SitemapEntry[] =>
  jobs.flatMap((job) => {
    const slug = job.slug?.trim()
    return slug
      ? [{ ...(job.updatedAt ? { lastModified: job.updatedAt } : {}), path: `/jobs/${encode(slug)}` }]
      : []
  })

/**
 * Full paths for a flat list of pages, walking each page's `parent` chain. A page whose parent
 * is missing or in a loop keeps the trail resolved so far, so a broken tree cannot hang a build.
 */
export const pageSitemapEntries = (
  pages: readonly {
    parent?: null | number | { id: number }
    role?: null | string
    slug?: null | string
    updatedAt?: null | string
  }[],
): SitemapEntry[] => {
  const byID = new Map<number, (typeof pages)[number]>()
  for (const page of pages) {
    const id = (page as { id?: number }).id
    if (typeof id === 'number') byID.set(id, page)
  }

  const trailOf = (page: (typeof pages)[number]): string[] => {
    const trail: string[] = []
    const seen = new Set<unknown>()
    let parentID = typeof page.parent === 'object' && page.parent !== null ? page.parent.id : page.parent
    let current = typeof parentID === 'number' ? byID.get(parentID) : undefined

    while (current && current !== page && !seen.has(current)) {
      seen.add(current)
      const slug = current.slug?.trim()
      if (slug) trail.unshift(encode(slug))
      parentID = typeof current.parent === 'object' && current.parent !== null ? current.parent.id : current.parent
      current = typeof parentID === 'number' ? byID.get(parentID) : undefined
    }

    return trail
  }

  return pages.flatMap((page) => {
    let path: string
    if (page.role === 'home') path = '/'
    else if (page.role === 'organisations') path = '/organisations'
    else {
      const slug = page.slug?.trim()
      if (!slug) return []
      path = `/${[...trailOf(page), encode(slug)].join('/')}`
    }

    return [{ ...(page.updatedAt ? { lastModified: page.updatedAt } : {}), path }]
  })
}

/**
 * Every URL the site offers a crawler: the home page, the listing, the filter pages that have
 * jobs, live jobs, the organisation directory and its public pages, and the published pages.
 *
 * `/jobs` and `/organisations` are empty without live jobs or a public organisation, so they
 * follow the same rule as a filter page. A path appears once however many sources name it.
 */
export const sitemapEntries = ({
  facets,
  filterPaths = defaultFilterPaths,
  jobs,
  organisations,
  pages,
}: SitemapSources): SitemapEntry[] => {
  const entries: SitemapEntry[] = [{ path: '/' }]

  const visible = jobs.filter((job) => {
    const typeIDs = refIDs(job.jobType)
    const separate = facets.types.filter((type) => type.isVolunteer === true).map((type) => type.id)
    return !typeIDs.some((id) => separate.includes(id))
  })
  if (visible.length > 0) entries.push({ path: '/jobs' })

  entries.push(...filterSitemapEntries({ facets, filterPaths, jobs }))
  entries.push(...jobSitemapEntries(jobs))

  if (organisations.length > 0) {
    entries.push({ path: '/organisations' })
    for (const organisation of organisations) {
      const slug = organisation.slug?.trim()
      if (!slug) continue
      entries.push({
        ...(organisation.updatedAt ? { lastModified: organisation.updatedAt } : {}),
        path: `/organisations/${encode(slug)}`,
      })
    }
  }

  entries.push(...pageSitemapEntries(pages))

  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.path)) return false
    seen.add(entry.path)
    return true
  })
}

/** `&` must not end the element early, and `'` too, for XML 1.0. */
export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/** An absolute URL for a sitemap file: the site's trailing slash dropped, the path kept. */
export const absoluteUrl = (siteUrl: string, path: string): string => {
  const origin = siteUrl.trim().replace(/\/+$/, '')
  const relative = path.startsWith('/') ? path : `/${path}`

  return `${origin}${relative}`
}

/**
 * The absolute URL of a page, in the form the theme marks canonical: a trailing slash, no query.
 * Listing a different form would tell a crawler about a URL the page then canonicalises away.
 */
export const pageUrl = (siteUrl: string, path: string): string => canonicalUrl(siteUrl, path)

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
const SITEMAP_NAMESPACE = 'http://www.sitemaps.org/schemas/sitemap/0.9'

const lastModifiedLine = (value: null | string | undefined, indent: string): string => {
  if (!value) return ''

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : `\n${indent}<lastmod>${date.toISOString()}</lastmod>`
}

/** One `urlset`: the sitemap a small site serves, and each shard of a large one. */
export const urlsetXml = (
  entries: readonly SitemapEntry[],
  { siteUrl }: { siteUrl: string },
): string => {
  const urls = entries.map(
    (entry) =>
      `  <url>\n    <loc>${escapeXml(pageUrl(siteUrl, entry.path))}</loc>` +
      `${lastModifiedLine(entry.lastModified, '    ')}\n  </url>`,
  )

  return `${XML_DECLARATION}\n<urlset xmlns="${SITEMAP_NAMESPACE}">\n${urls.join('\n')}\n</urlset>\n`
}

/** The index that points at the shards, once a site has more URLs than one sitemap may hold. */
export const sitemapIndexXml = (
  shards: readonly { lastModified?: null | string; path: string }[],
  { siteUrl }: { siteUrl: string },
): string => {
  const items = shards.map(
    (shard) =>
      `  <sitemap>\n    <loc>${escapeXml(absoluteUrl(siteUrl, shard.path))}</loc>` +
      `${lastModifiedLine(shard.lastModified, '    ')}\n  </sitemap>`,
  )

  return `${XML_DECLARATION}\n<sitemapindex xmlns="${SITEMAP_NAMESPACE}">\n${items.join(
    '\n',
  )}\n</sitemapindex>\n`
}

/** Cut the entries into sitemap-sized shards. Order is kept, so shard 2 stays shard 2. */
export const sitemapShards = (
  entries: readonly SitemapEntry[],
  { maxUrls = SITEMAP_MAX_URLS }: { maxUrls?: number } = {},
): SitemapEntry[][] => {
  const size = Math.max(1, Math.trunc(maxUrls))
  if (entries.length === 0) return [[]]

  const shards: SitemapEntry[][] = []
  for (let index = 0; index < entries.length; index += size) {
    shards.push(entries.slice(index, index + size))
  }

  return shards
}

export type SitemapPlan = {
  /** `/sitemap.xml`: a single `urlset` for a small site, an index once it has shards. */
  index: string
  /** Shard files, in order. Empty when the whole site fits in one sitemap. */
  shards: { path: string; xml: string }[]
}

/** Build every document the sitemap routes serve, from one set of entries. */
export const sitemapPlan = ({
  entries,
  maxUrls = SITEMAP_MAX_URLS,
  siteUrl,
}: {
  entries: readonly SitemapEntry[]
  maxUrls?: number
  siteUrl: string
}): SitemapPlan => {
  const shards = sitemapShards(entries, { maxUrls })

  if (shards.length <= 1) {
    return { index: urlsetXml(shards[0] ?? [], { siteUrl }), shards: [] }
  }

  const files = shards.map((shard, position) => ({
    path: sitemapShardPath(position + 1),
    xml: urlsetXml(shard, { siteUrl }),
  }))

  return { index: sitemapIndexXml(files.map(({ path }) => ({ path })), { siteUrl }), shards: files }
}
