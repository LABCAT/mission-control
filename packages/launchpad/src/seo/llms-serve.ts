/**
 * Load and serve a site's `/llms.txt` (PJ-104).
 *
 * `loadLlms` is the only part that touches the network. It reads what the site already publishes
 * — live jobs, public organisations and indexable pages — with the same rules the sitemap uses,
 * so the file cannot name a URL the site hides. `serveLlms` renders the cached text response.
 */
import { cacheTag, cachedResponse, type CacheLike } from '../cms/cache'
import type { CmsFindOptions } from '../cms/types'
import { liveJobsWhere } from '../jobs/listing'
import { pagePath, type ContentPage } from '../pages/pathing'
import { resolveLocale } from '../tenant/locale'
import type { SiteTenant } from '../tenant/types'
import { llmsTxt, type LlmsLink, type LlmsSection, type LlmsTxtInput } from './llms'

/** Content changes at most a few times a day, and a purge (PJ-41) clears it sooner. */
export const LLMS_TTL_SECONDS = 60 * 60

/** The most jobs the file lists. Past this an agent should read `/jobs`, not a 10,000-line file. */
export const LLMS_JOB_LIMIT = 100

/** The CMS surface the loader needs, by plain slug: slugs come from plugin options (PJ-80). */
export type LlmsCms = {
  findAll(collection: string, query?: CmsFindOptions): Promise<unknown[]>
}

export type LlmsSlugs = {
  jobs?: string
  organisations?: string
  pages?: string
}

const DEFAULT_SLUGS: Required<LlmsSlugs> = {
  jobs: 'jobs',
  organisations: 'organisations',
  pages: 'pages',
}

type JobDoc = { slug?: null | string; title?: null | string }
type OrganisationDoc = { name?: null | string; slug?: null | string }
type PageDoc = ContentPage & { seo?: null | { noIndex?: null | boolean } }

/** A page is listed unless its SEO tab says `noIndex`, or it is still a draft. */
const isIndexablePage = (page: PageDoc): boolean =>
  page['_status'] !== 'draft' && page.seo?.noIndex !== true

const link = (name: null | string | undefined, path: string, note?: string): LlmsLink | null => {
  const trimmed = name?.trim()
  return trimmed ? { name: trimmed, ...(note ? { note } : {}), path } : null
}

export type LoadLlmsOptions = {
  cms: LlmsCms
  /** The site's own summary, when the tenant or the home page has one. */
  description?: null | string
  now?: Date
  slugs?: LlmsSlugs
  tenant: SiteTenant
}

/** What the file says: the tenant, its summary and the links, before any URL is made absolute. */
export const loadLlms = async ({
  cms,
  description,
  now = new Date(),
  slugs: overrides = {},
  tenant,
}: LoadLlmsOptions): Promise<Omit<LlmsTxtInput, 'siteUrl'>> => {
  const slugs = { ...DEFAULT_SLUGS, ...overrides }
  const locale = resolveLocale(tenant)

  const [jobDocs, organisationDocs, pageDocs] = await Promise.all([
    cms.findAll(slugs.jobs, {
      limit: LLMS_JOB_LIMIT,
      locale,
      sort: ['-publishedAt', '-id'],
      where: liveJobsWhere(now),
    }),
    cms.findAll(slugs.organisations, { locale, sort: 'name' }),
    cms.findAll(slugs.pages, { draft: false, locale, sort: 'title' }),
  ])

  const jobs = (jobDocs as JobDoc[]).flatMap((job) => {
    const slug = job.slug?.trim()
    const entry = slug ? link(job.title, `/jobs/${encodeURIComponent(slug)}`) : null

    return entry ? [entry] : []
  })

  const organisations = (organisationDocs as OrganisationDoc[]).flatMap((organisation) => {
    const slug = organisation.slug?.trim()
    const entry = slug ? link(organisation.name, `/organisations/${encodeURIComponent(slug)}`) : null

    return entry ? [entry] : []
  })

  const pages = (pageDocs as PageDoc[])
    .filter(isIndexablePage)
    .flatMap((page) => {
      const path = pagePath(page, pageDocs as ContentPage[])
      const entry = path && path !== '/' ? link(page.title, path) : null

      return entry ? [entry] : []
    })

  const sections: LlmsSection[] = pages.length > 0 ? [{ links: pages, title: 'Pages' }] : []

  return {
    ...(description?.trim() ? { description: description.trim() } : {}),
    jobs,
    organisations,
    pages: sections,
    tenant,
  }
}

export type ServeLlmsOptions = Omit<LoadLlmsOptions, 'tenant'> & {
  cache?: CacheLike
  /** The tenant slug, scoping the cache key and the purge tags. */
  site: string
  /** Absolute origin, e.g. `https://vanuatuwok.vu`. Without one the file cannot be built. */
  siteUrl: null | string
  tenant: SiteTenant
  ttl?: number
}

const TEXT_HEADERS = {
  'cache-control': 'public, max-age=3600',
  'content-type': 'text/plain; charset=utf-8',
}

/**
 * Serve `/llms.txt` from the edge cache. No canonical origin means no absolute URLs, and a file
 * of relative links is worse than none, so that answers 404 rather than a half-useful file.
 */
export const serveLlms = async ({
  cache,
  site,
  siteUrl,
  tenant,
  ttl = LLMS_TTL_SECONDS,
  ...loadOptions
}: ServeLlmsOptions): Promise<Response> => {
  const origin = siteUrl?.trim()
  if (!origin) {
    return new Response('llms.txt is not configured', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      status: 404,
    })
  }

  return cachedResponse(
    `${site}:llms`,
    ttl,
    async () => {
      const content = await loadLlms({ ...loadOptions, tenant })

      return new Response(llmsTxt({ ...content, siteUrl: origin }), {
        headers: TEXT_HEADERS,
        status: 200,
      })
    },
    { cache, tags: [cacheTag('site', site)] },
  )
}
