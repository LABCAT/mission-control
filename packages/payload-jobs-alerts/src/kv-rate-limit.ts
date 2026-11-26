import type { Payload } from 'payload'

import { atomicKV, type RateLimiter } from '@mission-control/payload-jobs'

/**
 * A rate limiter every Worker shares (PJ-47). The in-memory limiter lives in one isolate, and
 * Cloudflare's Rate Limiting binding is per location and approximate, so neither can promise "at
 * most 3 emails an hour to one address". This one counts in Payload's KV table, with the atomic
 * windowed counter PJ-109 added (`countInWindow`): one SQL statement per request, so requests that
 * arrive together each get their own count and exactly `limit` of them pass.
 *
 * It fails closed: with no atomic counter (not Postgres) or an error, the answer is "over the
 * limit", so a broken limiter cannot turn into unlimited email. Keys hold a hash, never the address.
 */

export const MAIL_SLOT_PREFIX = 'alert-rl:'

/** At most this many alert emails to one address in each window. */
export const ALERT_MAIL_LIMIT = 3
export const ALERT_MAIL_WINDOW_MS = 60 * 60 * 1000

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type KvRateLimiterOptions = {
  /** Requests allowed per key in each window. */
  limit: number
  /** Injectable clock for tests, in milliseconds. */
  now?: () => number
  windowMs: number
}

export const createKvRateLimiter =
  ({ limit, now = Date.now, windowMs }: KvRateLimiterOptions) =>
  (payload: Payload): RateLimiter => ({
    limit: async ({ key }) => {
      try {
        const atomic = atomicKV(payload)
        if (!atomic) return { success: false }

        const count = await atomic.countInWindow(`${MAIL_SLOT_PREFIX}${await sha256Hex(key)}`, windowMs, now())

        return { success: count <= limit }
      } catch {
        return { success: false }
      }
    },
  })

/**
 * Delete counters whose window is over. A counter starts again in place when its window ends, but
 * an address that never writes again leaves its row behind, and the store has no expiry, so the
 * daily task calls this. It returns how many it removed; only this limiter's keys are looked at.
 */
export const purgeStaleMailSlots = async (
  payload: Payload,
  { now = new Date() }: { now?: Date } = {},
): Promise<number> => {
  let deleted = 0

  for (const key of await payload.kv.keys()) {
    if (!key.startsWith(MAIL_SLOT_PREFIX)) continue

    const record = await payload.kv.get<{ windowEnd?: number }>(key)
    if (typeof record?.windowEnd !== 'number' || record.windowEnd > now.getTime()) continue

    await payload.kv.delete(key)
    deleted += 1
  }

  return deleted
}
