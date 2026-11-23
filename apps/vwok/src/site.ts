import { createCmsClient, type CmsClient } from '@mission-control/launchpad/cms'
import type { SiteCollections } from '@mission-control/launchpad/pages'

/** The server-only values this site reads the CMS with (PJ-35). */
export type SiteEnv = {
  CMS_URL?: null | string
  SITE_KEY?: null | string
}

/**
 * The CMS client for this deployment, or `null` when the CMS is not configured. Both values are
 * Worker secrets, so a local checkout, a preview build and the Lighthouse run have neither and
 * the site falls back to its static shell instead of failing to render.
 */
export const cmsFromEnv = (env: SiteEnv): CmsClient | null => {
  const baseUrl = env.CMS_URL?.trim()
  const siteKey = env.SITE_KEY?.trim()
  if (!baseUrl || !siteKey) return null

  return createCmsClient({ baseUrl, siteKey })
}

/**
 * The CMS collection slugs this site reads. They are the slugs `apps/cms` resolves from the
 * payload-jobs plugin options (PJ-80); this app names them so a rename is a one-line change here
 * rather than a hidden assumption in the theme.
 */
export const SITE_COLLECTIONS: SiteCollections = {
  jobs: 'jobs',
  menus: 'menus',
  pages: 'pages',
}
