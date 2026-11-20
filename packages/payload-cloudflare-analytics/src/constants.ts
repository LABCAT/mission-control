/** Custom config key holding the server-only service for the admin component. */
export const CLOUDFLARE_ANALYTICS_CUSTOM_KEY = 'cloudflareAnalytics'

export const PACKAGE_NAME = '@mission-control/payload-cloudflare-analytics'

export const DEFAULT_ACCOUNT_ID_ENV = 'CLOUDFLARE_ANALYTICS_ACCOUNT_ID'
export const DEFAULT_API_TOKEN_ENV = 'CLOUDFLARE_ANALYTICS_API_TOKEN'
export const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000
export const DEFAULT_ENDPOINT_PATH = '/cloudflare-analytics'
export const DASHBOARD_COMPONENT_PATH = `${PACKAGE_NAME}/rsc#CloudflareAnalyticsDashboard`
