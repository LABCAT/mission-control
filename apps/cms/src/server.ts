import handler from '@tanstack/react-start/server-entry'

import { health } from './health'
import { runScheduled } from './jobs/runScheduled'

export default {
  // Same call as orbit's re-export: workerd passes (request, env, ctx) straight through.
  // mission-control: `/health` for UptimeRobot (PJ-41): the Worker and the database, never cached.
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === '/health') return health()
    return (handler.fetch as unknown as ExportedHandlerFetchHandler<Env>)(request, env, ctx)
  },

  // mission-control: Cloudflare Cron Triggers (wrangler.jsonc `triggers.crons`) drive Payload jobs.
  async scheduled(_controller, _env, ctx) {
    const [{ getPayload }, { default: config }] = await Promise.all([
      import('payload'),
      import('./payload.config'),
    ])
    const payload = await getPayload({ config })
    ctx.waitUntil(runScheduled(payload.jobs))
  },
} satisfies ExportedHandler<Env>
