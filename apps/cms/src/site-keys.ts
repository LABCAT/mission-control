import { createSiteKeyAccessOverride } from '@mission-control/payload-jobs'

/**
 * Collections a site key may read. Keep this explicit: a new content collection is not
 * exposed to public sites until it is added here.
 */
export const siteKeyAllowedCollections = [
  'folders',
  'locations',
  'media',
  'tags',
  // mission-control: job-board taxonomies (PJ-16). Job tags and areas of focus were
  // removed in PJ-80 (no legacy terms).
  'job-categories',
  'job-types',
  'salary-bands',
  // mission-control: pages and menus, read published only (PJ-103).
  'pages',
  'menus',
] as const

export const siteKeyAccessOverride = createSiteKeyAccessOverride({
  allowedCollections: siteKeyAllowedCollections,
})
