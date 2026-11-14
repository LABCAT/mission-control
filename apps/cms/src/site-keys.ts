import { createSiteKeyAccessOverride } from '@mission-control/payload-jobs'

/**
 * Collections a site key may read. Keep this explicit: a new content collection is not
 * exposed to public sites until it is added here.
 */
export const siteKeyAllowedCollections = [
  'folders',
  'media',
  'pages',
  'site-settings',
  'tags',
] as const

export const siteKeyAccessOverride = createSiteKeyAccessOverride({
  allowedCollections: siteKeyAllowedCollections,
})
