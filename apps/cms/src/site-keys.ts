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
    // mission-control: the organisation directory and profile pages (PJ-38). Only organisations
    // the collection's own rule calls public are returned (see `ownAccessCollections` below).
    slugs.organisations,
  ] as const

export const siteKeyAccessOverrideFor = (slugs: PayloadJobsCollectionSlugs) =>
  createSiteKeyAccessOverride({
    allowedCollections: siteKeyAllowedCollections(slugs),
    // mission-control: private, unapproved and possible-duplicate organisations are not readable
    // by a site key (PJ-38), so the collection's access result is kept, not replaced.
    ownAccessCollections: [slugs.organisations],
  })
