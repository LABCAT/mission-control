import handler from '@tanstack/react-start/server-entry'

import { handleEmailEvents } from './jobs/emailEvents'
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

  // mission-control: Cloudflare Email Sending delivery events arrive here from the Queue once the
  // consumer is enabled in wrangler.jsonc (PJ-107). They update the email log and suppression list.
  async queue(batch) {
    await handleEmailEvents(batch.messages, async () => {
      const [{ getPayload }, { default: config }] = await Promise.all([import('payload'), import('./payload.config')])

      return getPayload({ config })
    })
  },
} satisfies ExportedHandler<Env>
