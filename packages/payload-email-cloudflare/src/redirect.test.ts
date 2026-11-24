import { describe, expect, it, vi } from 'vitest'

import { cloudflareEmail } from './index'

const setup = (redirect: Parameters<typeof cloudflareEmail>[0] extends infer O ? (O extends { redirect?: infer R } ? R : never) : never) => {
  const send = vi.fn().mockResolvedValue(undefined)
  const info = vi.fn()
  const adapter = cloudflareEmail({ binding: { send } as never, redirect })({ payload: { logger: { info } } as never })
  return { send, info, adapter }
}
const message = {
  from: 'jobs@x.test',
  to: ['applicant@example.com', { name: 'Boss', address: 'boss@example.com' }],
  cc: 'cc@example.com',
  bcc: ['bcc@example.com'],
  subject: 'Your application',
  html: '<p>Hi</p>',
}

describe('redirect-all @S-161', () => {
  it('delivers normally when no redirect applies (production)', async () => {
    const { send, adapter } = setup(() => undefined)
    await adapter.sendEmail(message)
    const sent = send.mock.calls[0]![0]
    expect(sent.subject).toBe('Your application')
    expect(sent.cc).toBe('cc@example.com')
    expect(sent.bcc).toEqual(['bcc@example.com'])
  })

  it('replaces to, strips cc/bcc and shows the original recipients @S-162', async () => {
    const { send, adapter } = setup({ to: 'inbox@team.test', label: 'preview' })
    await adapter.sendEmail(message)
    expect(send).toHaveBeenCalledTimes(1)
    const sent = send.mock.calls[0]![0]
    expect(sent.to).toBe('inbox@team.test')
    expect(sent.cc).toBeUndefined()
    expect(sent.bcc).toBeUndefined()
    expect(sent.subject).toBe(
      '[preview → applicant@example.com, boss@example.com, cc:cc@example.com, bcc:bcc@example.com] Your application',
    )
    expect(JSON.stringify(sent)).not.toMatch(/"(?:email|to)":"(?:applicant|cc|bcc)@/)
  })

  it('never delivers when the inbox is missing, and does not log recipients @S-163', async () => {
    for (const inbox of [undefined, '', '   ']) {
      const { send, info, adapter } = setup(async () => ({ to: inbox, label: 'preview' }))
      await adapter.sendEmail(message)
      expect(send).not.toHaveBeenCalled()
      expect(JSON.stringify(info.mock.calls)).not.toContain('example.com')
    }
  })

  it('also redirects the Resend path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }))
    const adapter = cloudflareEmail({
      provider: 'resend',
      resend: { apiKey: 'k', fetch: fetchMock as never },
      redirect: { to: 'inbox@team.test', label: 'preview' },
    })({ payload: { logger: { info: vi.fn() } } as never })
    await adapter.sendEmail(message)
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.to).toEqual(['inbox@team.test'])
    expect(body.cc).toBeUndefined()
    expect(body.bcc).toBeUndefined()
  })
})
