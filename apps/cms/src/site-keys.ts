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
  // mission-control: job-board taxonomies (PJ-16).
  'areas-of-focus',
  'job-categories',
  'job-tags',
  'job-types',
  'salary-bands',
] as const

export const siteKeyAccessOverride = createSiteKeyAccessOverride({
  allowedCollections: siteKeyAllowedCollections,
})
