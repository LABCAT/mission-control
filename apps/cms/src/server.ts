import handler from '@tanstack/react-start/server-entry'

import { runScheduled } from './jobs/runScheduled'

export default {
  // Same call as orbit's re-export: workerd passes (request, env, ctx) straight through.
  fetch: handler.fetch as unknown as ExportedHandlerFetchHandler<Env>,

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
