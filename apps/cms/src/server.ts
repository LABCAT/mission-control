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

  // mission-control: Cloudflare Email Sending delivery events arrive here from the Queue
  // (wrangler.jsonc `queues.consumers`). They update the email log and suppression list (PJ-107).
  async queue(batch) {
    const [{ getPayload }, { default: config }, { consumeDeliveryEvents, emailEngineConfig }] = await Promise.all([
      import('payload'),
      import('./payload.config'),
      import('@mission-control/payload-jobs'),
    ])
    const payload = await getPayload({ config })
    const { logSlug, suppressionsSlug } = emailEngineConfig(payload)
    if (!suppressionsSlug) throw new Error('email suppressions are not enabled')
    await consumeDeliveryEvents({ logSlug, payload, suppressionsSlug }, batch.messages)
  },
} satisfies ExportedHandler<Env>
