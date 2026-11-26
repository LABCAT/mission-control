import type { Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { createKvRateLimiter, MAIL_SLOT_PREFIX, purgeStaleMailSlots } from './kv-rate-limit'

/**
 * A stand-in for Payload's KV store. `set` refuses a key that already exists, the way the
 * database adapter's unique key does when two requests create the same row at once.
 */
const fakeKV = () => {
  const store = new Map<string, unknown>()
  const kv = {
    delete: async (key: string) => void store.delete(key),
    get: async (key: string) => (store.get(key) as never) ?? null,
    has: async (key: string) => store.has(key),
    keys: async () => [...store.keys()],
    set: async (key: string, value: unknown) => {
      // A slow database: the check and the write are separate round trips.
      await Promise.resolve()
      if (store.has(key)) throw new Error('duplicate key')
      store.set(key, value)
    },
  }

  return { payload: { kv } as unknown as Payload, store }
}

const HOUR = 60 * 60 * 1000

describe('kv rate limiter @S-372', () => {
  it('allows the limit within a window, then refuses', async () => {
    const { payload } = fakeKV()
    const limiter = createKvRateLimiter({ limit: 3, now: () => 1_000, windowMs: HOUR })(payload)

    const results = []
    for (let index = 0; index < 5; index += 1) results.push((await limiter.limit({ key: 'a' })).success)

    expect(results).toEqual([true, true, true, false, false])
  })

  it('starts again in the next window', async () => {
    const { payload } = fakeKV()
    let now = 1_000
    const limiter = createKvRateLimiter({ limit: 1, now: () => now, windowMs: HOUR })(payload)

    expect((await limiter.limit({ key: 'a' })).success).toBe(true)
    expect((await limiter.limit({ key: 'a' })).success).toBe(false)
    now += HOUR
    expect((await limiter.limit({ key: 'a' })).success).toBe(true)
  })

  it('counts each key on its own', async () => {
    const { payload } = fakeKV()
    const limiter = createKvRateLimiter({ limit: 1, now: () => 1, windowMs: HOUR })(payload)

    expect((await limiter.limit({ key: 'a' })).success).toBe(true)
    expect((await limiter.limit({ key: 'b' })).success).toBe(true)
    expect((await limiter.limit({ key: 'a' })).success).toBe(false)
  })

  it('lets exactly the limit through when requests arrive at the same moment', async () => {
    const { payload } = fakeKV()
    const limiter = createKvRateLimiter({ limit: 3, now: () => 5, windowMs: HOUR })(payload)

    const results = await Promise.all(Array.from({ length: 12 }, () => limiter.limit({ key: 'a' })))

    expect(results.filter((result) => result.success)).toHaveLength(3)
  })

  it('never stores the address: only a hash of the key is in the store', async () => {
    const { payload, store } = fakeKV()
    const limiter = createKvRateLimiter({ limit: 1, now: () => 1, windowMs: HOUR })(payload)
    await limiter.limit({ key: 'alert-mail:1:jo@example.com' })

    expect([...store.keys()].every((key) => key.startsWith(MAIL_SLOT_PREFIX))).toBe(true)
    expect([...store.keys()].join(' ')).not.toMatch(/jo|example/)
  })

  it('fails closed when the store is down, so a broken limiter cannot become unlimited mail', async () => {
    const payload = {
      kv: {
        has: async () => {
          throw new Error('db down')
        },
      },
    } as unknown as Payload
    const limiter = createKvRateLimiter({ limit: 3, windowMs: HOUR })(payload)

    expect((await limiter.limit({ key: 'a' })).success).toBe(false)
  })
})

describe('purge of finished windows @S-372', () => {
  it('removes slots from past windows and keeps the current one and other keys', async () => {
    const { payload, store } = fakeKV()
    let now = 10 * HOUR + 5
    const limiter = createKvRateLimiter({ limit: 3, now: () => now, windowMs: HOUR })(payload)
    await limiter.limit({ key: 'a' })
    now += 2 * HOUR
    await limiter.limit({ key: 'a' })
    store.set('unrelated-key', 1)

    expect(await purgeStaleMailSlots(payload, { now: new Date(now), windowMs: HOUR })).toBe(1)
    expect(store.size).toBe(2)
    expect(store.has('unrelated-key')).toBe(true)
  })
})
