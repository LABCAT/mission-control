import type { Config, Plugin } from 'payload'

import { getPayloadJobsRegistry } from '@mission-control/payload-jobs'

/** The key tenants list in their `addOns` setting. */
export const REPORTS_ADD_ON_KEY = 'reports'

export type PayloadJobsReportsOptions = {
  /** Turn the add-on off without removing it from the config. Defaults to true. */
  enabled?: boolean
}

/**
 * Reports add-on skeleton (PJ-115). It registers itself so tenants can switch it on or off;
 * PJ-53 adds the reports (jobs and orders by month, job views) with
 * `registry.reports.register({ addOn: REPORTS_ADD_ON_KEY, ... })`. No collections, no schema.
 */
export const payloadJobsReports =
  (options: PayloadJobsReportsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    getPayloadJobsRegistry(incoming).addOns.register({
      description: 'CSV reports for site managers.',
      key: REPORTS_ADD_ON_KEY,
      label: 'Reports',
    })

    return incoming
  }
