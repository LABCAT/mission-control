import handler from '@tanstack/react-start/server-entry'

import { runScheduled } from './jobs/runScheduled'

const fetchHandler = handler.fetch as unknown as ExportedHandlerFetchHandler<Env>

export default {
  // mission-control: never let a browser reuse admin HTML from a previous Worker deployment.
  // The hashed /assets/* files change between deploys; cached HTML then points at missing files
  // and the admin sits on its loading spinner. API requests keep their own cache headers.
  async fetch(request, env, ctx) {
    const response = await fetchHandler(request, env, ctx)

    if (!new URL(request.url).pathname.startsWith('/admin')) return response

    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-store')

    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    })
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
