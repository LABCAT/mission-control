import { describe, expect, it, vi } from 'vitest'

import { cloudflareEmail, EmailSendError, mapToCloudflareMessage, mapToResendPayload } from './index'

const SECRET = 're_super_secret_key_123'
const caught = async (run: Promise<unknown>): Promise<EmailSendError> => {
  try {
    await run
  } catch (error) {
    return error as EmailSendError
  }
  throw new Error('expected rejection')
}
const ok = () => vi.fn().mockResolvedValue(new Response('{"id":"1"}', { status: 200 }))
const payload = () => {
  const info = vi.fn()
  return { info, payload: { logger: { info } } as never }
}

describe('mapToCloudflareMessage', () => {
  it('maps nodemailer address/name objects to the binding email/name shape', () => {
    expect(
      mapToCloudflareMessage({
        from: { name: 'Vanuatu Wok', address: 'jobs@vanuatuwok.vu' },
        to: [{ name: 'Applicant', address: 'applicant@example.com' }, 'cc@example.com'],
        subject: 'Your application',
        html: '<p>Thanks</p>',
      }),
    ).toEqual({
      from: { name: 'Vanuatu Wok', email: 'jobs@vanuatuwok.vu' },
      to: [{ name: 'Applicant', email: 'applicant@example.com' }, 'cc@example.com'],
      subject: 'Your application',
      html: '<p>Thanks</p>',
    })
  })

  it('passes plain-string addresses through and maps cc, bcc, replyTo, text, headers', () => {
    const message = mapToCloudflareMessage({
      from: 'jobs@x.test',
      to: 'a@x.test',
      cc: [{ name: 'C', address: 'c@x.test' }],
      bcc: 'b@x.test',
      replyTo: { name: 'R', address: 'r@x.test' },
      subject: 's',
      text: 'plain',
      headers: { 'X-Tag': '1' },
    })
    expect(message).toEqual({
      from: 'jobs@x.test',
      to: 'a@x.test',
      cc: [{ name: 'C', email: 'c@x.test' }],
      bcc: 'b@x.test',
      replyTo: { name: 'R', email: 'r@x.test' },
      subject: 's',
      text: 'plain',
      headers: { 'X-Tag': '1' },
    })
  })

  it('splits a "Name <addr>" string into the binding shape', () => {
    expect(mapToCloudflareMessage({ from: '"Jobs" <jobs@x.test>', to: 'a@x.test' }).from).toEqual({
      name: 'Jobs',
      email: 'jobs@x.test',
    })
  })

  it('maps attachments: binding supports them, inline vs attachment by cid', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const message = mapToCloudflareMessage({
      to: 'a@x.test',
      attachments: [
        { filename: 'a.pdf', content: bytes, contentType: 'application/pdf' },
        { filename: 'logo.png', content: 'aGk=', encoding: 'base64', contentType: 'image/png', cid: 'logo' },
      ],
    })
    expect(message.attachments).toEqual([
      { disposition: 'attachment', filename: 'a.pdf', type: 'application/pdf', content: bytes },
      {
        disposition: 'inline',
        contentId: 'logo',
        filename: 'logo.png',
        type: 'image/png',
        content: new Uint8Array([104, 105]),
      },
    ])
  })

  it('rejects path/href attachments instead of dropping them', () => {
    expect(() => mapToCloudflareMessage({ to: 'a@x.test', attachments: [{ path: '/etc/x' }] })).toThrow(
      EmailSendError,
    )
  })
})

describe('cloudflareEmail adapter', () => {
  it('logs without recipient, subject, or body when there is no binding outside Workers', async () => {
    const { info, payload: p } = payload()
    await cloudflareEmail()({ payload: p }).sendEmail({
      from: 'jobs@x.test',
      to: 'private-applicant@example.com',
      subject: 'Private application subject',
      html: '<p>secret token 123</p>',
    })
    expect(info).toHaveBeenCalledTimes(1)
    const logged = String(((info.mock.calls[0] as [{ msg?: string }])[0]).msg)
    for (const leaked of ['private-applicant@example.com', 'Private application subject', 'secret token 123']) {
      expect(logged).not.toContain(leaked)
    }
  })

  it('console transport never touches the binding', async () => {
    const send = vi.fn()
    const { info, payload: p } = payload()
    await cloudflareEmail({ transport: 'console', binding: { send } })({ payload: p }).sendEmail({ to: 'a@x.test' })
    expect(send).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledOnce()
  })

  it('returns the binding message id so the email log can match delivery events @S-387', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '<abc@mail.example>' })
    const adapter = cloudflareEmail({ binding: { send } })({ payload: payload().payload })

    expect(await adapter.sendEmail({ from: 'a@x.test', to: 'b@x.test' })).toEqual({ messageId: '<abc@mail.example>' })
    send.mockResolvedValue(undefined)
    expect(await adapter.sendEmail({ from: 'a@x.test', to: 'b@x.test' })).toBeUndefined()
  })

  it('sends through the binding, applying defaults only when from is missing', async () => {
    const send = vi.fn().mockResolvedValue({})
    const adapter = cloudflareEmail({
      defaultFromAddress: 'noreply@x.test',
      defaultFromName: 'Default',
      binding: { send },
    })({ payload: payload().payload })
    await adapter.sendEmail({ to: 'a@x.test', subject: 's' })
    await adapter.sendEmail({ from: { name: 'Tenant', address: 'jobs@t.test' }, to: 'a@x.test', subject: 's' })
    expect(send.mock.calls[0]?.[0]?.from).toEqual({ name: 'Default', email: 'noreply@x.test' })
    expect(send.mock.calls[1]?.[0]?.from).toEqual({ name: 'Tenant', email: 'jobs@t.test' })
    expect(adapter.defaultFromAddress).toBe('noreply@x.test')
  })

  it('wraps binding errors without recipient data', async () => {
    const send = vi.fn().mockRejectedValue(new Error('sender domain not verified'))
    const adapter = cloudflareEmail({ binding: { send } })({ payload: payload().payload })
    const error = await caught(adapter.sendEmail({ from: 'a@x.test', to: 'victim@example.com' }))
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.message).toContain('sender domain not verified')
    expect(error.message).not.toContain('victim@example.com')
  })
})

describe('resend fallback', () => {
  it('is used when the binding is missing', async () => {
    const fetchMock = ok()
    const adapter = cloudflareEmail({ resend: { apiKey: SECRET, fetch: fetchMock } })({ payload: payload().payload })
    await adapter.sendEmail({
      from: { name: 'Jobs', address: 'jobs@x.test' },
      to: [{ name: 'A', address: 'a@x.test' }],
      cc: 'c@x.test',
      replyTo: 'r@x.test',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      attachments: [{ filename: 'a.txt', content: 'hi', contentType: 'text/plain' }],
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://api.resend.com/emails')
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(String(init.body))).toEqual({
      from: 'Jobs <jobs@x.test>',
      to: ['A <a@x.test>'],
      cc: ['c@x.test'],
      reply_to: 'r@x.test',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }],
    })
  })

  it('provider: resend skips an available binding', async () => {
    const send = vi.fn()
    const fetchMock = ok()
    await cloudflareEmail({ provider: 'resend', binding: { send }, resend: { apiKey: SECRET, fetch: fetchMock } })({
      payload: payload().payload,
    }).sendEmail({ from: 'a@x.test', to: 'b@x.test' })
    expect(send).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('reads the key from RESEND_API_KEY and never puts it in errors', async () => {
    vi.stubEnv('RESEND_API_KEY', SECRET)
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: `bad key ${SECRET}` }), { status: 401 }))
    const adapter = cloudflareEmail({ provider: 'resend', resend: { fetch: fetchMock } })({
      payload: payload().payload,
    })
    const error = await caught(adapter.sendEmail({ from: 'a@x.test', to: 'b@x.test' }))
    vi.unstubAllEnvs()
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.status).toBe(401)
    expect(error.message).toContain('HTTP 401')
    expect(error.message).not.toContain(SECRET)
  })

  it('scrubs the key from network failures and missing-key errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error(`connect failed with ${SECRET}`))
    const adapter = cloudflareEmail({ resend: { apiKey: () => SECRET, fetch: fetchMock } })({
      payload: payload().payload,
    })
    const error = await caught(adapter.sendEmail({ from: 'a@x.test', to: 'b@x.test' }))
    expect(error.message).not.toContain(SECRET)

    vi.stubEnv('RESEND_API_KEY', '')
    const noKey = cloudflareEmail({ provider: 'resend', resend: {} })({ payload: payload().payload })
    await expect(noKey.sendEmail({ from: 'a@x.test', to: 'b@x.test' })).rejects.toThrow(/no API key/)
    vi.unstubAllEnvs()
  })

  it("provider 'resend' without a resend option is a configuration error", async () => {
    const adapter = cloudflareEmail({ provider: 'resend' })({ payload: payload().payload })
    await expect(adapter.sendEmail({ to: 'a@x.test' })).rejects.toThrow(/requires the `resend` option/)
  })

  it('mapToResendPayload rejects path attachments', () => {
    expect(() => mapToResendPayload({ to: 'a@x.test', attachments: [{ href: 'https://x' }] })).toThrow(EmailSendError)
  })
})
