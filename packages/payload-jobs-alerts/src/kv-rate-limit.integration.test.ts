import type { Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'

import { createKvRateLimiter, MAIL_SLOT_PREFIX, purgeStaleMailSlots } from './kv-rate-limit'

/**
 * The shared per-address limit against a real database: the count is one atomic statement
 * (PJ-109's `countInWindow`), so simultaneous requests cannot both read the same count.
 */

const HOUR = 60 * 60 * 1000

describe('kv rate limiter @S-372', () => {
  let harness: TestHarness
  let payload: Payload
  let run = 0

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: [] })
    payload = harness.payload
  })

  afterAll(async () => {
    await harness.destroy()
  })

  /** A key no other test shares, so counts start from zero. */
  const fresh = (label: string) => `${label}-${++run}-${Math.random().toString(36).slice(2)}`

  it('allows the limit within a window, then refuses', async () => {
    const limiter = createKvRateLimiter({ limit: 3, now: () => 1_000, windowMs: HOUR })(payload)
    const key = fresh('basic')

    const results = []
    for (let index = 0; index < 5; index += 1) results.push((await limiter.limit({ key })).success)

    expect(results).toEqual([true, true, true, false, false])
  })

  it('starts again once the window has ended', async () => {
    let now = 1_000
    const limiter = createKvRateLimiter({ limit: 1, now: () => now, windowMs: HOUR })(payload)
    const key = fresh('window')

    expect((await limiter.limit({ key })).success).toBe(true)
    expect((await limiter.limit({ key })).success).toBe(false)
    now += HOUR + 1
    expect((await limiter.limit({ key })).success).toBe(true)
  })

  it('counts each key on its own', async () => {
    const limiter = createKvRateLimiter({ limit: 1, now: () => 1, windowMs: HOUR })(payload)
    const a = fresh('a')
    const b = fresh('b')

    expect((await limiter.limit({ key: a })).success).toBe(true)
    expect((await limiter.limit({ key: b })).success).toBe(true)
    expect((await limiter.limit({ key: a })).success).toBe(false)
  })

  it('lets exactly the limit through when requests arrive at the same moment', async () => {
    const limiter = createKvRateLimiter({ limit: 3, now: () => 5, windowMs: HOUR })(payload)
    const key = fresh('race')

    const results = await Promise.all(Array.from({ length: 15 }, () => limiter.limit({ key })))

    expect(results.filter((result) => result.success)).toHaveLength(3)
  })

  it('never stores the address: only a hash of the key is in the store', async () => {
    const limiter = createKvRateLimiter({ limit: 1, now: () => 1, windowMs: HOUR })(payload)
    await limiter.limit({ key: 'alert-mail:1:private.person@example.com' })

    const keys = (await payload.kv.keys()).filter((key) => key.startsWith(MAIL_SLOT_PREFIX))
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.join(' ')).not.toMatch(/private|person|example/)
  })

  it('fails closed when the store has no atomic counter, so a broken limiter is not unlimited mail', async () => {
    const limiter = createKvRateLimiter({ limit: 3, windowMs: HOUR })({ db: {} } as unknown as Payload)

    expect((await limiter.limit({ key: 'a' })).success).toBe(false)
  })

  it('removes counters whose window is over, and leaves live counters and other keys alone', async () => {
    const old = createKvRateLimiter({ limit: 3, now: () => 10 * HOUR, windowMs: HOUR })(payload)
    const live = createKvRateLimiter({ limit: 3, now: () => 100 * HOUR, windowMs: HOUR })(payload)
    const past = fresh('past')
    const current = fresh('current')
    await old.limit({ key: past })
    await live.limit({ key: current })
    await payload.kv.set('unrelated-key', { keep: true })

    const before = (await payload.kv.keys()).filter((key) => key.startsWith(MAIL_SLOT_PREFIX)).length
    const removed = await purgeStaleMailSlots(payload, { now: new Date(100 * HOUR + 1) })
    const after = (await payload.kv.keys()).filter((key) => key.startsWith(MAIL_SLOT_PREFIX)).length

    expect(removed).toBeGreaterThanOrEqual(1)
    expect(after).toBe(before - removed)
    expect(await payload.kv.has('unrelated-key')).toBe(true)
    // The live counter still counts: one more request is request number two.
    expect((await live.limit({ key: current })).success).toBe(true)
  })
})
