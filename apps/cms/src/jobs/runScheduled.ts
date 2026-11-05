import type { Payload } from 'payload'

/** Queues defined in task `schedule` configs. Every cron tick schedules then runs all of them. */
export const SCHEDULED_QUEUES = ['hourly'] as const

type JobsAPI = Pick<Payload['jobs'], 'handleSchedules' | 'run'>

/**
 * Called from the Worker `scheduled()` handler. Payload's own autoRun crons don't work on
 * Workers (no long-lived process), so Cloudflare Cron Triggers drive the queues instead.
 * Tasks decide their own timing with `schedule[].cron`; this just ticks the system.
 */
export async function runScheduled(jobs: JobsAPI, { limit = 50 }: { limit?: number } = {}) {
  for (const queue of SCHEDULED_QUEUES) {
    await jobs.handleSchedules({ queue })
    // Cron runs have no user; Payload 4 checks run access, so the system runner overrides it.
    await jobs.run({ queue, limit, overrideAccess: true })
  }
}
