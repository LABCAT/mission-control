/**
 * Where a CMS page lives on the site. Pages are a tree (`parent` → children) and the URL is the
 * chain of slugs, so `/about/team` is the page `team` under `about`. Two system pages own their
 * branch outright: Home is `/` itself and Organisations is `/organisations` (PJ-103).
 *
 * Everything here is pure: a site app loads the pages once and resolves a request path against
 * them, so /<parent>/<slug> and an unknown path are decided by data, not by the router.
 */

/** The fields the path rules read. A Payload `pages` document satisfies it; tests pass objects. */
export type ContentPage = {
  _status?: null | string
  id: number | string
  layout?: null | readonly { blockType?: string; [key: string]: unknown }[]
  parent?: { id: number | string } | null | number | string
  role?: null | string
  seo?: null | {
    description?: null | string
    image?:
      | null
      | { alt?: null | string; height?: null | number; url?: null | string; width?: null | number }
      | number
    noIndex?: null | boolean
    title?: null | string
  }
  slug?: null | string
  title: string
}

/**
 * A parent chain longer than this is not a page tree, it is a loop (the CMS refuses cycles, so
 * this is a backstop). Stopping keeps every walk finite.
 */
export const MAX_PAGE_DEPTH = 12

export const pageID = (value: ContentPage['parent']): null | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return String(value.id)
  return String(value)
}

/** Pages by id, so a parent relationship that arrives as an id still resolves. */
export const pageIndex = (pages: readonly ContentPage[]): Map<string, ContentPage> =>
  new Map(pages.map((page) => [String(page.id), page]))

const segment = (value: null | string | undefined): null | string => {
  const trimmed = value?.trim()
  return trimmed ? encodeURIComponent(trimmed) : null
}

/**
 * The page's path, or `null` when it has no usable address: a normal page with no slug, or a
 * parent that is missing from `pages` (the chain cannot be built, so the page is not served).
 *
 * A trailing slash is not part of the path; the canonical link adds one.
 */
export const pagePath = (page: ContentPage, pages: readonly ContentPage[] = []): null | string => {
  // Home is `/` itself and nothing nests under it, so its own slug never appears.
  if (page.role === 'home') return '/'

  const byID = pageIndex(pages)
  const segments: string[] = []
  let current: ContentPage | undefined = page

  for (let depth = 0; depth < MAX_PAGE_DEPTH; depth += 1) {
    // Reaching home ends the chain: its own address is `/`, so it contributes no segment.
    if (!current) return null
    if (current.role === 'home') return `/${segments.join('/')}`

    const own = segment(current.slug)
    if (!own) return null
    segments.unshift(own)

    // Organisations keeps its own address; its role fixes the branch (PJ-103).
    if (current.role === 'organisations') return `/${segments.join('/')}`

    const parentID = pageID(current.parent)
    if (parentID === null) return `/${segments.join('/')}`

    current = byID.get(parentID)
    // A page whose parent is not in the set has no chain to the root, so no address either.
    if (!current) return null
  }

  return null
}

/** Every page with a usable address, keyed by path. Two pages cannot share one (PJ-103). */
export const pagePaths = (pages: readonly ContentPage[]): Map<string, ContentPage> => {
  const byPath = new Map<string, ContentPage>()

  for (const page of pages) {
    const path = pagePath(page, pages)
    if (path && !byPath.has(path)) byPath.set(path, page)
  }

  return byPath
}

/**
 * A request path as the lookup sees it: no query string, no trailing slash, percent-decoded
 * segments. `//about` and `/about/` both read as `/about`; `/` stays `/`.
 */
export const normalisePath = (pathname: string): string => {
  const withoutQuery = pathname.split(/[?#]/)[0] ?? '/'
  const decoded = withoutQuery
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        // A malformed escape is not a page: keep it as typed so the lookup misses.
        return part
      }
    })
    .join('/')
  const collapsed = decoded.replace(/\/{2,}/g, '/').replace(/\/+$/, '')

  return collapsed === '' ? '/' : `/${collapsed.replace(/^\/+/, '')}`
}

/**
 * The chain of pages from the site root to `page`, each with its path. Breadcrumbs and the
 * `BreadcrumbList` structured data both read this, so the trail a visitor sees and the trail a
 * crawler reads cannot disagree.
 *
 * A page whose chain is broken contributes what could be resolved; the page itself is always
 * last, and a page with no usable address has no trail at all.
 */
export const pageTrail = (
  page: ContentPage,
  pages: readonly ContentPage[],
): { name: string; page: ContentPage; path: string }[] => {
  const byID = pageIndex(pages)
  const chain: ContentPage[] = [page]
  const seen = new Set<unknown>([String(page.id)])

  let current = page
  for (let depth = 0; depth < MAX_PAGE_DEPTH; depth += 1) {
    if (current.role === 'home' || current.role === 'organisations') break

    const parentID = pageID(current.parent)
    if (parentID === null) break

    const parent = byID.get(parentID)
    if (!parent || seen.has(parentID)) break
    seen.add(parentID)
    chain.unshift(parent)
    current = parent
  }

  return chain.flatMap((entry) => {
    const path = pagePath(entry, pages)

    return path ? [{ name: entry.title, page: entry, path }] : []
  })
}

export type ContentRoute =
  | { kind: 'not-found' }
  | { kind: 'page'; page: ContentPage; path: string }

/** The page a request path names, or `not-found`. The site app turns that into a 404. */
export const resolveContentRoute = (
  pages: readonly ContentPage[],
  pathname: string,
): ContentRoute => {
  const path = normalisePath(pathname)
  const page = pagePaths(pages).get(path)

  return page ? { kind: 'page', page, path } : { kind: 'not-found' }
}
