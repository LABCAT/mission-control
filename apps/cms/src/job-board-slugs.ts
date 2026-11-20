import {
  resolvePayloadJobsSlugs,
  type PayloadJobsCollectionsOptions,
} from '@mission-control/payload-jobs'

/**
 * The one place a host renames a job-board collection. Everything that names one of those
 * collections — the plugin itself, the multi-tenant plugin, the site-key allowlist and the
 * seed scripts — reads the resolved slugs, so a rename cannot leave one of them behind.
 */
export const payloadJobsCollectionOptions: PayloadJobsCollectionsOptions = {}

export const payloadJobsCollectionSlugs = resolvePayloadJobsSlugs(payloadJobsCollectionOptions)
