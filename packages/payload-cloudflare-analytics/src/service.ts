import type { MaybePromise, PayloadRequest } from 'payload'

import { fetchCloudflareAnalytics } from './api'
import { createMemoryCache } from './cache'
import {
  DEFAULT_ACCOUNT_ID_ENV,
  DEFAULT_API_TOKEN_ENV,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_ENDPOINT_PATH,
} from './constants'
import type { AnalyticsLoadResult, AnalyticsRange, CloudflareAnalyticsData } from './types'

export type CloudflareAnalyticsOptions = {
  /** Environment variable or secret name holding the Cloudflare account id. */
  accountIdEnv?: string
  /** Environment variable or secret name holding the Account Analytics:Read token. */
  apiTokenEnv?: string
  /** How long a successful response is kept per isolate. Defaults to one hour. */
  cacheTtlMs?: number
  /** Payload API path for the read-only endpoint. Defaults to `/cloudflare-analytics`. */
  endpointPath?: string
  /** Environment object override, mostly for tests. Defaults to `process.env` when present. */
  environment?: Record<string, string | undefined>
  /** `fetch` override, for tests. */
  fetch?: typeof fetch
  /** Clock override, for tests. */
  now?: () => Date
  /**
   * Resolve the Cloudflare Web Analytics site tag for the current tenant. Return
   * `undefined`/`null` (or omit the option) when the tenant has no analytics yet.
   */
  resolveSiteTag?: (req: PayloadRequest) => MaybePromise<null | string | undefined>
}

export type CloudflareAnalyticsService = {
  endpointPath: string
  load: (args: { range: AnalyticsRange; req: PayloadRequest }) => Promise<AnalyticsLoadResult>
}

type Credentials = {
  accountId: string
  apiToken: string
}

const processEnvironment = (): Record<string, string | undefined> => {
  const globalProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process
  return globalProcess?.env ?? {}
}

/**
 * Build the request-scoped loader shared by the endpoint and the admin dashboard. The
 * env names are resolved at request time so a Worker secret is used as soon as it exists.
 */
export const createCloudflareAnalyticsService = (
  options: CloudflareAnalyticsOptions = {},
): CloudflareAnalyticsService => {
  const accountIdEnv = options.accountIdEnv ?? DEFAULT_ACCOUNT_ID_ENV
  const apiTokenEnv = options.apiTokenEnv ?? DEFAULT_API_TOKEN_ENV
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  const now = options.now ?? (() => new Date())
  const endpointPath = options.endpointPath ?? DEFAULT_ENDPOINT_PATH
  const cache = createMemoryCache<CloudflareAnalyticsData>(() => now().getTime())

  const credentials = (): Credentials | null => {
    const env = options.environment ?? processEnvironment()
    const accountId = env[accountIdEnv]?.trim()
    const apiToken = env[apiTokenEnv]?.trim()
    return accountId && apiToken ? { accountId, apiToken } : null
  }

  return {
    endpointPath,
    load: async ({ range, req }) => {
      const siteTag = (await options.resolveSiteTag?.(req))?.trim()
      const auth = credentials()
      if (!siteTag || !auth) return { configured: false }

      // The key holds no secret. The token is never cached or returned.
      const cacheKey = `${auth.accountId}\u0000${siteTag}\u0000${range}`
      const cached = cache.get(cacheKey)
      if (cached) return { configured: true, data: cached }

      const data = await fetchCloudflareAnalytics({
        accountId: auth.accountId,
        apiToken: auth.apiToken,
        fetchImpl: options.fetch,
        now: now(),
        range,
        siteTag,
      })
      cache.set(cacheKey, data, cacheTtlMs)
      return { configured: true, data }
    },
  }
}
