import type { CmsClient } from '@mission-control/launchpad/cms'
import { loadSite, type MenuView } from '@mission-control/launchpad/pages'
import {
  loadOrganisationProfile,
  type OrganisationProfile,
} from '@mission-control/launchpad/organisations'
import { resolveLocale } from '@mission-control/launchpad/tenant/locale'

import { siteTenant } from './brand'
import { SITE_COLLECTIONS } from './site'

export type OrganisationRoute =
  | { kind: 'found'; menus: MenuView[]; profile: OrganisationProfile }
  | { kind: 'not-found'; menus: MenuView[] }

/**
 * Resolve `/organisations/{slug}` (PJ-38). Private, unapproved and possible-duplicate
 * organisations are not readable with the site key, so they fall out as `not-found`: the same
 * 404 as a slug that never existed. (A noindex stub per tenant setting is not built; the default
 * is the 404.) With no CMS configured there is no organisation to show.
 */
export const organisationRoute = async ({
  cms,
  slug,
}: {
  cms: CmsClient | null
  slug: string
}): Promise<OrganisationRoute> => {
  if (!cms) return { kind: 'not-found', menus: [] }

  // The menus come from the same load a CMS page uses, so the chrome matches the other pages.
  const [site, profile] = await Promise.all([
    loadSite({
      cms,
      collections: SITE_COLLECTIONS,
      locale: resolveLocale(siteTenant),
      pathname: '/organisations',
      tenant: siteTenant,
    }),
    loadOrganisationProfile({ cms, collections: SITE_COLLECTIONS, slug, tenant: siteTenant }),
  ])

  return profile.kind === 'found'
    ? { kind: 'found', menus: site.menus, profile: profile.profile }
    : { kind: 'not-found', menus: site.menus }
}
