import type { Config, Plugin } from 'payload'

import { getPayloadJobsRegistry } from '@mission-control/payload-jobs'

import { reportEndpoints } from './endpoint'
import { reportDefinitions, REPORTS_ADD_ON_KEY } from './reports'

export * from './csv'
export * from './endpoint'
export * from './range'
export * from './reports'
export * from './service'

export const REPORTS_VIEW_COMPONENT_PATH = '@mission-control/payload-jobs-reports/client#ReportsView'
export const REPORTS_VIEW_PATH = '/reports'

export type PayloadJobsReportsOptions = {
  /** Turn the add-on off without removing it from the config. Defaults to true. */
  enabled?: boolean
}

/**
 * Reports add-on (PJ-53). List it after `payloadJobs()`. It registers the add-on and two report
 * types in the core registry (jobs and orders by month, job views), the `/api/reports`
 * endpoints and an admin page at `/admin/reports`. No collections, so no schema change.
 *
 * A tenant that leaves `reports` out of its `addOns` setting sees no reports and its endpoints
 * answer 404. Other add-ons can register more reports with `registry.reports.register`.
 */
export const payloadJobsReports =
  (options: PayloadJobsReportsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const registry = getPayloadJobsRegistry(incoming)

    registry.addOns.register({
      description: 'CSV reports for site managers.',
      key: REPORTS_ADD_ON_KEY,
      label: 'Reports',
    })
    for (const report of reportDefinitions(registry)) registry.reports.register(report)

    return {
      ...incoming,
      admin: {
        ...incoming.admin,
        components: {
          ...incoming.admin?.components,
          views: {
            ...incoming.admin?.components?.views,
            reports: { Component: REPORTS_VIEW_COMPONENT_PATH, path: REPORTS_VIEW_PATH },
          },
        },
      },
      endpoints: [...(incoming.endpoints ?? []), ...reportEndpoints(registry)],
    }
  }
