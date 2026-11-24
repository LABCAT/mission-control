import {
  createSiteKeyAccessOverride,
  type PayloadJobsCollectionSlugs,
} from '@mission-control/payload-jobs'

/**
 * Collections a site key may read. Keep this explicit: a new content collection is not
 * exposed to public sites until it is added here.
 *
 * The plugin's collections are named by their resolved slugs, so a host that renames one
 * keeps its site-key access instead of silently dropping out of the allowlist.
 */
export const siteKeyAllowedCollections = (slugs: PayloadJobsCollectionSlugs) =>
  [
    'folders',
    'media',
    'tags',
    // mission-control: job-board taxonomies (PJ-16). Job tags and areas of focus were
    // removed in PJ-80 (no legacy terms).
    slugs.locations,
    slugs.jobCategories,
    slugs.jobTypes,
    slugs.salaryBands,
    // mission-control: pages and menus, read published only (PJ-103).
    slugs.pages,
    slugs.menus,
    // mission-control: the site's name, logo, footer, language and header banner (PJ-67).
    slugs.siteSettings,
  ] as const

export const siteKeyAccessOverrideFor = (slugs: PayloadJobsCollectionSlugs) =>
  createSiteKeyAccessOverride({ allowedCollections: siteKeyAllowedCollections(slugs) })
