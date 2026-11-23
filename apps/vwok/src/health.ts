import { healthResponse } from '@mission-control/launchpad/tenant/health'

import type { SiteEnv } from './env'

/**
 * `/health` for UptimeRobot (PJ-41): the Worker answering is the first check; the second asks the
 * CMS, whose own `/health` checks its database. Never cached.
 */
export const siteHealth = (env: SiteEnv, fetcher: typeof fetch = fetch): Promise<Response> =>
  healthResponse({
    cms: async () => {
      const base = env.CMS_URL?.trim()
      // No CMS configured (a local checkout): nothing to check, the Worker alone is the answer.
      if (!base) return
      const response = await fetcher(new URL('/health', base), { headers: { 'cache-control': 'no-cache' } })
      if (!response.ok) throw new Error(`CMS health ${response.status}`)
    },
    worker: async () => {},
  })
