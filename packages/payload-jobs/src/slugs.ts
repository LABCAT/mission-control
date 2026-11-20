import type { CollectionConfig } from 'payload'

/**
 * Every collection slug is resolved from the plugin options (PJ-80). Generic slugs such as
 * `locations`, `organisations` and `jobs` clash on other sites, so a host can rename any of
 * them without the plugin's relationships or queries pointing at the default.
 */

export type CollectionAccess = NonNullable<CollectionConfig['access']>

/** Per-collection options: a slug override and/or access overrides. */
export type PayloadJobsCollectionOptions = {
  /** Overrides the collection's `access`, operation by operation. */
  access?: CollectionAccess
  slug?: string
}

export type PayloadJobsCollectionKey =
  | 'addOns'
  | 'alertSubscriptions'
  | 'coupons'
  | 'jobCategories'
  | 'jobs'
  | 'jobTypes'
  | 'locations'
  | 'organisations'
  | 'plans'
  | 'salaryBands'

export type PayloadJobsCollectionsOptions = Partial<
  Record<PayloadJobsCollectionKey, PayloadJobsCollectionOptions>
>

/** The resolved slug for each collection the plugin adds. */
export type PayloadJobsCollectionSlugs = Record<PayloadJobsCollectionKey, string>

/**
 * Defaults, matching the mission-control installation. Choosing a slug before an app's first
 * schema migration needs nothing extra. Renaming one on an installation that already has the
 * tables changes the schema, so the app must generate and apply its own migration for it.
 */
export const DEFAULT_PAYLOAD_JOBS_SLUGS: PayloadJobsCollectionSlugs = {
  addOns: 'add-ons',
  alertSubscriptions: 'alert-subscriptions',
  coupons: 'coupons',
  jobCategories: 'job-categories',
  jobs: 'jobs',
  jobTypes: 'job-types',
  locations: 'locations',
  organisations: 'organisations',
  plans: 'plans',
  salaryBands: 'salary-bands',
}

/** Resolve each collection's slug from `collections: { locations: { slug } }`, filling defaults. */
export const resolvePayloadJobsSlugs = (
  collections: PayloadJobsCollectionsOptions = {},
): PayloadJobsCollectionSlugs =>
  (Object.keys(DEFAULT_PAYLOAD_JOBS_SLUGS) as PayloadJobsCollectionKey[]).reduce(
    (slugs, key) => {
      slugs[key] = collections[key]?.slug ?? DEFAULT_PAYLOAD_JOBS_SLUGS[key]
      return slugs
    },
    {} as PayloadJobsCollectionSlugs,
  )

/**
 * Merge a host's access overrides onto a collection's defaults. Overriding one operation leaves
 * the others exactly as the plugin defines them.
 */
export const mergeCollectionAccess = (
  defaults: CollectionAccess,
  override?: CollectionAccess,
): CollectionAccess => (override === undefined ? defaults : { ...defaults, ...override })
