import { describe, expect, it, vi } from 'vitest'

import { eventFor } from './__fixtures__/delivery-events'
import { consumeDeliveryEvents, normaliseMessageId, parseDeliveryEvent } from './deliverability'

describe('parseDeliveryEvent @S-385', () => {
  it('reads each kind and strips angle brackets from the message id', () => {
    for (const kind of ['delivered', 'deferred', 'failed', 'rejected', 'complained']) {
      expect(parseDeliveryEvent(eventFor(kind, '<abc@mail.example>'))).toMatchObject({ kind, messageId: 'abc@mail.example' })
    }
    expect(normaliseMessageId(' <x@y> ')).toBe('x@y')
  })

  it('treats a bounce as hard unless its type says soft', () => {
    expect(parseDeliveryEvent(eventFor('bounced', 'a'))).toMatchObject({ bounceType: 'hard' })
    expect(parseDeliveryEvent(eventFor('bounced', 'a', { bounceType: 'Permanent' }))).toMatchObject({ bounceType: 'hard' })
    expect(parseDeliveryEvent(eventFor('bounced', 'a', { bounceType: 'transient' }))).toMatchObject({ bounceType: 'soft' })
    expect(parseDeliveryEvent(eventFor('delivered', 'a'))).not.toHaveProperty('bounceType')
  })

  it('accepts a bare kind and a top-level message id, and rejects what it cannot use', () => {
    expect(parseDeliveryEvent({ type: 'bounced', messageId: 'z' })).toMatchObject({ kind: 'bounced', messageId: 'z' })
    expect(parseDeliveryEvent(eventFor('opened', 'a'))).toBeNull()
    expect(parseDeliveryEvent({ type: 'message.delivered', payload: {} })).toBeNull()
    expect(parseDeliveryEvent('nope')).toBeNull()
    expect(parseDeliveryEvent(null)).toBeNull()
  })
})

describe('consumeDeliveryEvents @S-385', () => {
  const message = (body: unknown, attempts = 1) => ({ ack: vi.fn(), attempts, body, retry: vi.fn() })
  const ctxWith = (find: () => Promise<{ docs: unknown[] }>) =>
    ({
      logSlug: 'email-log',
      payload: { find, update: vi.fn() },
      suppressionsSlug: 'email-suppressions',
    }) as never

  it('acks events it cannot parse, and retries an unknown message until the attempt limit', async () => {
    const ctx = ctxWith(async () => ({ docs: [] }))
    const junk = message({ hello: 1 })
    const early = message(eventFor('delivered', 'm1'))
    const late = message(eventFor('delivered', 'm1'), 5)

    const totals = await consumeDeliveryEvents(ctx, [junk, early, late])

    expect(junk.ack).toHaveBeenCalled()
    expect(early.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(early.ack).not.toHaveBeenCalled()
    expect(late.ack).toHaveBeenCalled()
    expect(totals).toEqual({ applied: 0, dropped: 2, retried: 1 })
  })

  it('retries when the database call fails', async () => {
    const ctx = ctxWith(async () => {
      throw new Error('db down')
    })
    const msg = message(eventFor('delivered', 'm1'))

    await consumeDeliveryEvents(ctx, [msg])

    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
  })
})
