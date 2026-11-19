import type { Plugin } from 'payload'

import {
  CLOUDFLARE_ANALYTICS_CUSTOM_KEY,
  DASHBOARD_COMPONENT_PATH,
  DEFAULT_ENDPOINT_PATH,
} from './constants'
import { createAnalyticsEndpoint } from './endpoint'
import { createCloudflareAnalyticsService, type CloudflareAnalyticsOptions } from './service'

export type { CloudflareAnalyticsOptions } from './service'

const normalizeEndpointPath = (path: string): string => {
  const trimmed = path.trim()
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash
}

/**
 * Add Cloudflare Web Analytics to the Payload admin:
 *
 * - a read-only `GET /api/<endpointPath>` endpoint (signed-in users from the admin user
 *   collection only; other auth collections get 403),
 * - a dashboard component above the collection list, scoped by `resolveSiteTag`.
 *
 * The service is stored in the server-only `config.custom` object so the dashboard server
 * component and the endpoint share one cache. The Cloudflare token is never put in config.
 */
export const cloudflareAnalyticsPlugin = (
  options: CloudflareAnalyticsOptions = {},
): Plugin => {
  const endpointPath = normalizeEndpointPath(options.endpointPath ?? DEFAULT_ENDPOINT_PATH)
  const service = createCloudflareAnalyticsService({ ...options, endpointPath })

  return (config) => ({
    ...config,
    admin: {
      ...config.admin,
      components: {
        ...config.admin?.components,
        beforeDashboard: [
          ...(config.admin?.components?.beforeDashboard ?? []),
          { path: DASHBOARD_COMPONENT_PATH },
        ],
      },
    },
    custom: {
      ...config.custom,
      [CLOUDFLARE_ANALYTICS_CUSTOM_KEY]: service,
    },
    endpoints: [...(config.endpoints ?? []), createAnalyticsEndpoint({ path: endpointPath, service })],
  })
}
