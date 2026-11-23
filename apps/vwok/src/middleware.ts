import { defineMiddleware } from 'astro:middleware'

import { siteEnv } from './env'
import { servePublic } from './public-cache'

// Every public page goes through the edge cache, keyed by the tenant's content version (PJ-41).
export const onRequest = defineMiddleware(async ({ request }, next) => {
  const cached = servePublic({ env: await siteEnv(), next, request })

  return cached ? await cached : next()
})
