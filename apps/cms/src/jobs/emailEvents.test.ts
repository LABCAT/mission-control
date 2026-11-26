import { describe, expect, it, vi } from 'vitest'

import { handleEmailEvents } from './emailEvents'

describe('handleEmailEvents @S-385', () => {
  it('acks and drops every message when email is not enabled, without throwing', async () => {
    const messages = [1, 2].map(() => ({ ack: vi.fn(), body: {}, retry: vi.fn() }))
    const payload = { config: { custom: {} } } as never

    const result = await handleEmailEvents(messages, async () => payload)

    expect(result).toEqual({ applied: 0, dropped: 2, retried: 0 })
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalled()
      expect(message.retry).not.toHaveBeenCalled()
    }
  })

  it('acks when suppressions are not configured', async () => {
    const message = { ack: vi.fn(), body: {}, retry: vi.fn() }
    const payload = { config: { custom: { payloadJobs: { email: { logSlug: 'email-log' } } } } } as never

    await handleEmailEvents([message], async () => payload)

    expect(message.ack).toHaveBeenCalled()
  })
})
