import type { Payload } from 'payload'

import type { RateLimiter } from '@mission-control/payload-jobs'

/**
 * A rate limiter every Worker shares (PJ-47). The in-memory limiter lives in one isolate, and
 * Cloudflare's Rate Limiting binding is per location and approximate, so neither can promise "at
 * most 3 emails an hour to one address". This one keeps its counts in Payload's KV store, which
 * is the database.
 *
 * The store has no atomic increment, so a request claims a numbered slot instead: slot 0, 1, ...
 * up to the limit, for this key and this window. Claiming is "create this row", and the store's
 * unique key makes exactly one of several simultaneous requests win each slot; the others see the
 * failure and move on to the next. When every slot is taken the request is over the limit.
 *
 * It fails closed: if the store cannot be reached the answer is "over the limit", so a broken
 * limiter cannot turn into unlimited email. Keys hold a hash, never the address.
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

const slotKey = (hash: string, window: number, slot: number): string =>
  `${MAIL_SLOT_PREFIX}${window}:${hash}:${slot}`

export const createKvRateLimiter =
  ({ limit, now = Date.now, windowMs }: KvRateLimiterOptions) =>
  (payload: Payload): RateLimiter => ({
    limit: async ({ key }) => {
      try {
        const window = Math.floor(now() / windowMs)
        const hash = await sha256Hex(key)

        for (let slot = 0; slot < limit; slot += 1) {
          const slotName = slotKey(hash, window, slot)
          if (await payload.kv.has(slotName)) continue

          try {
            await payload.kv.set(slotName, { at: now() })

            return { success: true }
          } catch {
            // Another request created this slot first: it is taken, try the next one.
          }
        }

        return { success: false }
      } catch {
        return { success: false }
      }
    },
  })

/**
 * Delete the slots of windows that are over. The store has no expiry, so the daily task calls
 * this; it returns how many it removed. Only keys with this limiter's prefix are looked at.
 */
export const purgeStaleMailSlots = async (
  payload: Payload,
  { now = new Date(), windowMs }: { now?: Date; windowMs: number },
): Promise<number> => {
  const current = Math.floor(now.getTime() / windowMs)
  let deleted = 0

  for (const key of await payload.kv.keys()) {
    if (!key.startsWith(MAIL_SLOT_PREFIX)) continue
    const window = Number(key.slice(MAIL_SLOT_PREFIX.length).split(':')[0])
    if (!Number.isFinite(window) || window >= current) continue

    await payload.kv.delete(key)
    deleted += 1
  }

  return deleted
}
