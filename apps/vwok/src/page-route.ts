import type { CmsClient } from '@mission-control/launchpad/cms'
import { loadSite, pageView, type MenuView, type PageView } from '@mission-control/launchpad/pages'
import { resolveLocale } from '@mission-control/launchpad/tenant/locale'

import { siteTenant } from './brand'
import { SITE_COLLECTIONS } from './site'

/**
 * What the request path asks for. Three answers, because the home page has a static shell for a
 * deployment with no CMS: the same page the CMS fills, so the switch changes copy only.
 */
export type PageRoute =
  | { kind: 'not-found'; menus: MenuView[] }
  | { kind: 'page'; menus: MenuView[]; view: PageView }
  | { kind: 'shell' }

/**
 * Resolve one public path against the site's CMS pages (PJ-39). Every page is a CMS document, so
 * the app has no route per page; an unknown path is a 404 whatever else is configured.
 *
 * A path is resolved as data (`loadSite`), never by the router: `/<parent>/<slug>` is the chain
 * of page slugs, and the home page is `/` by role.
 */
export const pageRoute = async ({
  cms,
  pathname,
  searchParams,
}: {
  cms: CmsClient | null
  pathname: string
  /** The query string, for the organisation directory's type and size filters (PJ-38). */
  searchParams?: Pick<URLSearchParams, 'get'>
}): Promise<PageRoute> => {
  if (!cms) return pathname === '/' ? { kind: 'shell' } : { kind: 'not-found', menus: [] }

  const content = await loadSite({
    cms,
    collections: SITE_COLLECTIONS,
    locale: resolveLocale(siteTenant),
    pathname,
    searchParams,
    tenant: siteTenant,
  })

  if (content.kind !== 'page') return { kind: 'not-found', menus: content.menus }

  return { kind: 'page', menus: content.menus, view: pageView(content, { tenant: siteTenant }) }
}
