/**
 * A CMS page as the theme draws it. The site app loads the site once, resolves the request path
 * against its pages, and renders the page's blocks in the editor's order with the site's menus.
 *
 * Nothing here fetches in a template: `loadSite` returns the page (and the jobs, when the layout
 * asks for them) and `pageView` turns that into the plain data a page template draws.
 */
import type { CmsClient } from '../cms/client'
import type { CmsCollectionSlug } from '../cms/types'
import type { SiteTenant } from '../tenant/types'
import { pageSegments, type PageSegment } from './blocks'
import { siteCollections, type SiteCollections } from './collections'
import { loadLatestJobs, type LatestJobsResult } from './latest-jobs'
import { menuViews, type ContentMenu, type MenuView } from './menus'
import { resolveContentRoute, type ContentPage } from './pathing'
import { pageMetadata, type PageMetadata } from './seo'

/** The latest-jobs block's data: the jobs it shows, and the feed link when the site has one. */
export type LatestJobsView = LatestJobsResult & { rssHref?: string }

export type LoadedPage = {
  latestJobs?: LatestJobsResult
  page: ContentPage
  /** `/`, `/about` … no trailing slash; the canonical link adds it. */
  path: string
  /** The layout split into what `RenderBlocks` draws and what needs the loaded jobs. */
  segments: PageSegment[]
}

export type PageView = {
  /** The blocks in the order the editor arranged them. */
  segments: PageSegment[]
  /** Present only when the layout names the latest-jobs block. */
  latestJobs?: LatestJobsView
  metadata: PageMetadata
  path: string
  page: ContentPage
}

export type PageViewOptions = {
  /** Where the site's job feed lives. The latest-jobs block links it when set. */
  rssHref?: string
  tenant: SiteTenant
}

/** The view a page template draws from a loaded page. */
export const pageView = (loaded: LoadedPage, { rssHref, tenant }: PageViewOptions): PageView => {
  const latestJobs = loaded.latestJobs
    ? { ...loaded.latestJobs, ...(rssHref ? { rssHref } : {}) }
    : undefined

  return {
    ...(latestJobs ? { latestJobs } : {}),
    metadata: pageMetadata(loaded.page, tenant),
    page: loaded.page,
    path: loaded.path,
    segments: loaded.segments,
  }
}

export type LoadSiteOptions = {
  cms: Pick<CmsClient, 'find' | 'findAll'>
  /** The site's resolved collection slugs (PJ-80), when its CMS renames any of them. */
  collections?: Partial<SiteCollections>
  /** The latest-jobs block's slug, when the site registered it under another one. */
  latestJobsSlug?: string
  /** Tenant locale, for the pages and the jobs the block shows. */
  locale?: string
  /** Path of the request, e.g. `/about/team`. Query and trailing slash are ignored. */
  pathname: string
  tenant: SiteTenant
}

export type SiteContent =
  | { kind: 'not-found'; menus: MenuView[] }
  | ({ kind: 'page'; menus: MenuView[] } & LoadedPage)

/**
 * The whole site read for one request: the menus, the page the path names, and the jobs when its
 * layout asks for them. Pages and menus come from one load, so a menu item's href is the page's
 * current path and the request makes one read of each collection.
 */
export const loadSite = async ({
  cms,
  collections,
  latestJobsSlug,
  locale,
  pathname,
  tenant,
}: LoadSiteOptions): Promise<SiteContent> => {
  const slugs = siteCollections(collections)
  const query = { depth: 1, ...(locale ? { locale } : {}), sort: 'title' }
  const [pageDocs, menuDocs] = await Promise.all([
    cms.findAll(slugs.pages as CmsCollectionSlug, query),
    cms.findAll(slugs.menus as CmsCollectionSlug, query),
  ])

  const pages = pageDocs as unknown as ContentPage[]
  const menus = menuViews(menuDocs as unknown as ContentMenu[], pages)
  const route = resolveContentRoute(pages, pathname)
  if (route.kind !== 'page') return { kind: 'not-found', menus }

  const { page, path } = route
  const segments = pageSegments(page.layout, latestJobsSlug)
  const latestJobsBlock = segments.find((segment) => segment.kind === 'latest-jobs')
  if (latestJobsBlock?.kind !== 'latest-jobs') return { kind: 'page', menus, page, path, segments }

  const latestJobs = await loadLatestJobs({
    cms,
    collection: slugs.jobs,
    limit: latestJobsBlock.block.limit,
    tenant,
  })

  return { kind: 'page', latestJobs, menus, page, path, segments }
}
