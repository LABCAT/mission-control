/**
 * Load a site's sitemap entries from the CMS and serve them.
 *
 * `loadSitemap` is the only part that touches the network: it reads the tenant's taxonomies, its
 * live jobs, its public organisations and its published pages, and hands them to the pure
 * builder in `./sitemap`. `serveSitemap` renders that plan into cached responses.
 *
 * The queries reuse the site's own rules rather than restating them: `liveJobsWhere` for jobs
 * (never an expired one), the approved-and-page-enabled rule for organisations, and drafts and
 * `noIndex` pages dropped for pages. So the sitemap cannot list a URL the site itself hides.
 */
import { cacheTag, cachedResponse, type CacheLike } from '../cms/cache'
import type { CmsQuery } from '../cms/types'
import { liveJobsWhere } from '../jobs/listing'
import { resolveLocale } from '../tenant/locale'
import type { SiteTenant } from '../tenant/types'
import {
  defaultFilterPaths,
  sitemapEntries,
  sitemapPlan,
  type FilterPaths,
  type SitemapEntry,
  type SitemapFacets,
  type SitemapPage,
} from './sitemap'

/** Content changes at most a few times a day, and a purge (PJ-41) clears it sooner. */
export const SITEMAP_TTL_SECONDS = 60 * 60

/**
 * The one read the loader makes. The collection name is a plain string rather than the
 * generated slug union, because slugs come from plugin options (PJ-80) and a site may rename a
 * collection; the theme must not depend on the default names.
 */
export type SitemapCms = {
  findAll(collection: string, query?: CmsQuery): Promise<unknown[]>
}

/** Resolved collection slugs. Defaults are the plugin's. */
export type SitemapSlugs = {
  jobCategories?: string
  jobs?: string
  jobTypes?: string
  locations?: string
  organisations?: string
  pages?: string
}

const DEFAULT_SLUGS: Required<SitemapSlugs> = {
  jobCategories: 'job-categories',
  jobs: 'jobs',
  jobTypes: 'job-types',
  locations: 'locations',
  organisations: 'organisations',
  pages: 'pages',
}

/** Payload's public-organisation rule (PJ-18): approved, with its page switched on. */
const PUBLIC_ORGANISATION_FILTER = {
  and: [{ approved: { equals: true } }, { pageEnabled: { equals: true } }],
}

export type LoadSitemapOptions = {
  cms: SitemapCms
  filterPaths?: FilterPaths
  /** The clock that decides which jobs are still live. */
  now?: Date
  slugs?: SitemapSlugs
  tenant: SiteTenant
}

export type Sitemap = {
  entries: SitemapEntry[]
  facets: SitemapFacets
}

type Ref = { id: number; slug: string }
type LocationRef = Ref & { parent?: null | number | { id: number } }
type TypeRef = Ref & { isVolunteer?: null | boolean }
type JobRef = {
  categories?: (null | number | { id: number })[] | null
  jobType?: null | number | { id: number }
  location?: (null | number | { id: number })[] | null
  slug?: null | string
  updatedAt?: null | string
}
type OrganisationRef = { slug?: null | string; updatedAt?: null | string }
type PageDoc = SitemapPage & {
  seo?: null | { noIndex?: null | boolean }
  /** Payload adds this to a drafts-enabled collection; `SitemapPage` keeps the shape minimal. */
  _status?: null | string
}

/**
 * A page is indexable unless its SEO tab says otherwise, or it is still a draft. `draft: false`
 * already asks for published rows only; the status check makes that independent of the response.
 * Bracket access because the field's leading underscore is Payload's, not this repo's style.
 */
const isIndexablePage = (page: PageDoc): boolean =>
  page['_status'] !== 'draft' && page.seo?.noIndex !== true

/**
 * Every URL the site may publish, in sitemap order.
 */
export const loadSitemap = async ({
  cms,
  filterPaths = defaultFilterPaths,
  now = new Date(),
  slugs: overrides = {},
  tenant,
}: LoadSitemapOptions): Promise<Sitemap> => {
  const slugs = { ...DEFAULT_SLUGS, ...overrides }
  const locale = resolveLocale(tenant)

  const [categories, types, locations, jobs, organisations, pages] = await Promise.all([
    cms.findAll(slugs.jobCategories, { locale, sort: 'name' }) as Promise<Ref[]>,
    cms.findAll(slugs.jobTypes, { locale, sort: 'name' }) as Promise<TypeRef[]>,
    cms.findAll(slugs.locations, { locale, sort: 'name' }) as Promise<LocationRef[]>,
    cms.findAll(slugs.jobs, { where: liveJobsWhere(now) }) as Promise<JobRef[]>,
    cms.findAll(slugs.organisations, { where: PUBLIC_ORGANISATION_FILTER }) as Promise<
      OrganisationRef[]
    >,
    cms.findAll(slugs.pages, { draft: false }) as Promise<PageDoc[]>,
  ])

  const facets: SitemapFacets = {
    categories: categories.map(({ id, slug }) => ({ id, slug })),
    locations: locations.map(({ id, parent, slug }) => ({
      id,
      parentID: typeof parent === 'object' && parent !== null ? parent.id : (parent ?? null),
      slug,
    })),
    types: types.map(({ id, isVolunteer, slug }) => ({ id, isVolunteer: isVolunteer === true, slug })),
  }

  return {
    entries: sitemapEntries({
      facets,
      filterPaths,
      jobs,
      organisations,
      pages: pages.filter(isIndexablePage),
    }),
    facets,
  }
}

export type ServeSitemapOptions = LoadSitemapOptions & {
  /** Cache API; defaults to `caches.default`. With no cache the XML is built every request. */
  cache?: CacheLike
  /** The request path: `/sitemap.xml`, or a shard such as `/sitemap-1.xml`. */
  path: string
  /** The tenant slug; scopes the cache key and the purge tags. */
  site: string
  /** Absolute origin, e.g. `https://vanuatuwok.vu`. */
  siteUrl: string
  /** How long the edge cache keeps an answer. Defaults to `SITEMAP_TTL_SECONDS`. */
  ttl?: number
}

const XML_HEADERS = {
  'cache-control': 'public, max-age=3600',
  'content-type': 'application/xml; charset=utf-8',
}

const notFound = (): Response =>
  new Response('Not found', {
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
    status: 404,
  })

/**
 * Serve one sitemap route from the edge cache.
 *
 * `/sitemap.xml` is a single `urlset` until the site outgrows one file, then an index whose
 * shards are `/sitemap-1.xml`, `/sitemap-2.xml` … A shard the current plan does not have is a
 * 404, so a shrinking site never serves a stale list.
 */
export const serveSitemap = async (options: ServeSitemapOptions): Promise<Response> => {
  const { cache, path, site, siteUrl, ttl = SITEMAP_TTL_SECONDS, ...loadOptions } = options
  const tags = [cacheTag('site', site), cacheTag('site', site, 'sitemap')]
  // Astro ignores a trailing slash here, so `/sitemap.xml/` and `/sitemap.xml` are one page: they
  // share a cache entry rather than each building the same XML.
  const normalised = path.length > 1 ? path.replace(/\/+$/, '') : path

  return cachedResponse(
    `${site}:sitemap:${normalised}`,
    ttl,
    async () => {
      const { entries } = await loadSitemap(loadOptions)
      const plan = sitemapPlan({ entries, siteUrl })

      if (normalised === '/sitemap.xml') {
        return new Response(plan.index, { headers: XML_HEADERS, status: 200 })
      }

      const shard = plan.shards.find((file) => file.path === normalised)
      return shard ? new Response(shard.xml, { headers: XML_HEADERS, status: 200 }) : notFound()
    },
    { cache, tags },
  )
}

/**
 * The shard number in a `/sitemap-<shard>.xml` request, or null for anything that is not a whole
 * number of at least one. A route uses it to 404 a shard it cannot name, so `/sitemap-0.xml` and
 * `/sitemap-latest.xml` never reach the loader.
 */
export const sitemapShardNumber = (path: string): null | number => {
  const match = /^\/sitemap-(\d+)\.xml\/?$/.exec(path)
  const shard = match ? Number(match[1]) : 0

  return Number.isSafeInteger(shard) && shard >= 1 ? shard : null
}
