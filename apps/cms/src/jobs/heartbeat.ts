import type { TaskConfig } from 'payload'

/** Proves the Worker cron → Payload jobs path works end to end. */
export const heartbeatTask: TaskConfig<'heartbeat'> = {
  slug: 'heartbeat',
  schedule: [{ cron: '0 0 * * * *', queue: 'hourly' }],
  handler: async ({ req }) => {
    await req.payload.updateGlobal({
      slug: 'system-status',
      data: { lastHeartbeatAt: new Date().toISOString() },
      overrideAccess: true,
      req,
    })
    return { output: {} }
  },
}
