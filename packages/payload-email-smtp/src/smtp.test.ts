import { registerHooks } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EmailSendError, encodeHeader, mapToSmtpEnvelope, sendViaSmtp, smtpEmail } from './index'
import type { EmailMessageInput, SmtpConfig } from './index'

/**
 * worker-mailer imports `cloudflare:sockets` at module load, which Node does not have.
 * Map it to an in-memory SMTP server so the real library runs against a mocked socket.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:sockets') {
      return { url: new URL('./test/cloudflare-sockets.cjs', import.meta.url).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

type FakeServer = {
  password: string
  refuse: boolean
  queueId: string
  commands: string[]
  recipients: string[]
  messageIds: string[]
  lastMessage?: string
}

const resetServer = (overrides: Partial<FakeServer> = {}): FakeServer => {
  const server: FakeServer = {
    password: 'correct-horse',
    refuse: false,
    queueId: 'ABC123',
    commands: [],
    recipients: [],
    messageIds: [],
    ...overrides,
  }
  ;(globalThis as { smtpTestServer?: FakeServer }).smtpTestServer = server
  return server
}

const config = (overrides: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: 'smtp.test',
  port: 587,
  secure: 'starttls',
  username: 'billing@example.com',
  password: 'correct-horse',
  fromAddress: 'billing@example.com',
  fromName: 'Example Billing',
  ...overrides,
})

const caught = async (run: Promise<unknown>): Promise<EmailSendError> => {
  try {
    await run
  } catch (error) {
    return error as EmailSendError
  }
  throw new Error('expected rejection')
}

const payload = () => {
  const info = vi.fn()
  return { info, payload: { logger: { info } } as never }
}

beforeEach(() => {
  resetServer()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('mapToSmtpEnvelope', () => {
  const message: EmailMessageInput = {
    from: { name: 'Vanuatu Wok', address: 'jobs@vanuatuwok.vu' },
    to: [{ name: 'Applicant', address: 'applicant@example.com' }, 'cc@example.com'],
    cc: 'copy@example.com',
    bcc: 'blind@example.com',
    replyTo: { name: 'Support', address: 'support@example.com' },
    subject: 'Your application',
    text: 'Thanks',
    html: '<p>Thanks</p>',
    headers: { 'X-Tag': '1' },
  }

  it('maps addresses and bodies to the worker-mailer shape', () => {
    const envelope = mapToSmtpEnvelope(config(), message)
    expect(envelope.from).toEqual({ name: 'Vanuatu Wok', email: 'jobs@vanuatuwok.vu' })
    expect(envelope.to).toEqual([
      { name: 'Applicant', email: 'applicant@example.com' },
      { email: 'cc@example.com' },
    ])
    expect(envelope.cc).toEqual([{ email: 'copy@example.com' }])
    expect(envelope.bcc).toEqual([{ email: 'blind@example.com' }])
    expect(envelope.reply).toEqual({ name: 'Support', email: 'support@example.com' })
    expect(envelope.subject).toBe('Your application')
    expect(envelope.text).toBe('Thanks')
    expect(envelope.html).toBe('<p>Thanks</p>')
    expect(envelope.headers).toMatchObject({ 'X-Tag': '1' })
    expect(envelope.headers['Message-ID']).toMatch(/^<[^@]+@vanuatuwok\.vu>$/)
  })

  it('falls back to the configured from address only when the message has none', () => {
    expect(mapToSmtpEnvelope(config(), { to: 'a@example.com' }).from).toEqual({
      name: 'Example Billing',
      email: 'billing@example.com',
    })
    expect(mapToSmtpEnvelope(config(), message).from.email).toBe('jobs@vanuatuwok.vu')
  })

  it('Q-encodes UTF-8 subjects and names (RFC 2047)', () => {
    expect(encodeHeader('Résumé ✓')).toBe('=?UTF-8?Q?R=C3=A9sum=C3=A9_=E2=9C=93?=')
    const envelope = mapToSmtpEnvelope(config(), {
      to: { name: 'Anne-Marie Ünicode', address: 'a@example.com' },
      subject: 'Résumé ✓',
    })
    expect(envelope.subject).toBe('=?UTF-8?Q?R=C3=A9sum=C3=A9_=E2=9C=93?=')
    expect(envelope.to[0]).toEqual({ name: '=?UTF-8?Q?Anne-Marie_=C3=9Cnicode?=', email: 'a@example.com' })
  })

  it('base64-encodes attachments and rejects path/href', () => {
    const envelope = mapToSmtpEnvelope(config(), {
      to: 'a@example.com',
      attachments: [
        { filename: 'a.txt', content: 'hi', contentType: 'text/plain' },
        { filename: 'b.bin', content: new Uint8Array([1, 2, 3]) },
        { filename: 'c.bin', content: 'AQID', encoding: 'base64' },
      ],
    })
    expect(envelope.attachments).toEqual([
      { filename: 'a.txt', content: 'aGk=', mimeType: 'text/plain' },
      { filename: 'b.bin', content: 'AQID' },
      { filename: 'c.bin', content: 'AQID' },
    ])
    expect(() => mapToSmtpEnvelope(config(), { to: 'a@example.com', attachments: [{ path: '/etc/x' }] })).toThrow(
      EmailSendError,
    )
  })
})

describe('sendViaSmtp over a mocked socket', () => {
  it('negotiates STARTTLS, authenticates, and returns the Message-ID it set', async () => {
    const server = resetServer()
    const messageId = await sendViaSmtp(config(), {
      to: { name: 'Applicant', address: 'applicant@example.com' },
      bcc: 'blind@example.com',
      subject: 'Résumé ✓',
      text: 'Thanks',
      html: '<p>Thanks</p>',
      attachments: [{ filename: 'note.txt', content: 'hi', contentType: 'text/plain' }],
    })

    expect(server.commands.some((line) => line === 'STARTTLS')).toBe(true)
    expect(server.commands.some((line) => line.startsWith('AUTH PLAIN'))).toBe(true)
    expect(server.recipients).toContain('RCPT TO: <blind@example.com>')
    expect(messageId).toMatch(/^<[^@]+@example\.com>$/)
    expect(server.lastMessage).toContain(`Message-ID: ${messageId}`)
    expect(server.lastMessage).toContain('Subject: =?UTF-8?Q?R=C3=A9sum=C3=A9_=E2=9C=93?=')
    expect(server.lastMessage).toContain('To: "Applicant" <applicant@example.com>')
    expect(server.lastMessage).not.toContain('Bcc:')
    expect(server.lastMessage).toContain('Content-Transfer-Encoding: base64')
    expect(server.lastMessage).toContain('aGk=')
  })

  it('uses implicit TLS without STARTTLS for secure: tls', async () => {
    const server = resetServer()
    await sendViaSmtp(config({ secure: 'tls', port: 465 }), { to: 'a@example.com', text: 'hello' })
    expect(server.commands.some((line) => line === 'STARTTLS')).toBe(false)
    expect(server.messageIds).toHaveLength(1)
  })

  it('wraps an auth failure without leaking the password', async () => {
    resetServer({ password: 'server-side-password' })
    const error = await caught(
      sendViaSmtp(config({ password: 'client-secret-123' }), { to: 'a@example.com', text: 'hello' }),
    )
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.provider).toBe('smtp')
    expect(error.message).toContain('535')
    expect(error.message).not.toContain('client-secret-123')
  })

  it('wraps a refused connection without leaking the password', async () => {
    resetServer({ refuse: true })
    const error = await caught(sendViaSmtp(config(), { to: 'a@example.com', text: 'hello' }))
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.message).toContain('ECONNREFUSED')
    expect(error.message).not.toContain('correct-horse')
  })

  it('never puts the password in errors or logs, even when the server echoes it', async () => {
    const logged: unknown[][] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args)
      })
    }
    resetServer({ password: 'server-side-password' })
    const error = await caught(
      sendViaSmtp(config({ password: 'client-secret-123' }), { to: 'a@example.com', text: 'hello' }),
    )
    const output = `${error.message}\n${JSON.stringify(logged)}`
    expect(output).not.toContain('client-secret-123')
    expect(output).not.toContain('server-side-password')
  })
})

describe('smtpEmail adapter', () => {
  it('logs without recipients, subject or body when SMTP is unconfigured outside Workers', async () => {
    const { info, payload: p } = payload()
    await smtpEmail({ defaultFromAddress: 'noreply@example.com' })({ payload: p }).sendEmail({
      to: 'private-applicant@example.com',
      subject: 'Private application subject',
      html: '<p>secret token 123</p>',
    })
    expect(info).toHaveBeenCalledOnce()
    const logged = String(((info.mock.calls[0] as [{ msg?: string }])[0]).msg)
    for (const leaked of ['private-applicant@example.com', 'Private application subject', 'secret token 123']) {
      expect(logged).not.toContain(leaked)
    }
  })

  it('console transport never opens a connection', async () => {
    const server = resetServer()
    const { info, payload: p } = payload()
    await smtpEmail({ username: 'billing@example.com', passwordEnv: 'SMTP_PASSWORD', transport: 'console' })({
      payload: p,
    }).sendEmail({ to: 'a@example.com', text: 'hello' })
    expect(server.commands).toHaveLength(0)
    expect(info).toHaveBeenCalledOnce()
  })

  it('reads the password from the configured env name and applies default from', async () => {
    vi.stubEnv('SMTP_PASSWORD', 'correct-horse')
    const server = resetServer()
    const adapter = smtpEmail({
      username: 'billing@example.com',
      defaultFromAddress: 'billing@example.com',
      defaultFromName: 'Example Billing',
    })({ payload: payload().payload })

    const result = await adapter.sendEmail({ to: 'a@example.com', subject: 'Hi', text: 'hello' })
    expect(result).toEqual({ messageId: expect.any(String) })
    expect(server.lastMessage).toContain('From: "Example Billing" <billing@example.com>')

    await adapter.sendEmail({ from: { name: 'Tenant', address: 'jobs@tenant.test' }, to: 'a@example.com', text: 'x' })
    expect(server.lastMessage).toContain('From: "Tenant" <jobs@tenant.test>')
    expect(adapter.defaultFromAddress).toBe('billing@example.com')
  })

  it('honours a custom password env name', async () => {
    vi.stubEnv('WORKSPACE_SMTP_PASSWORD', 'correct-horse')
    resetServer()
    const adapter = smtpEmail({
      username: 'billing@example.com',
      passwordEnv: 'WORKSPACE_SMTP_PASSWORD',
      defaultFromAddress: 'billing@example.com',
    })({ payload: payload().payload })
    await expect(adapter.sendEmail({ to: 'a@example.com', text: 'hello' })).resolves.toEqual({
      messageId: expect.any(String),
    })
  })

  it('surfaces a send failure as a typed error', async () => {
    vi.stubEnv('SMTP_PASSWORD', 'correct-horse')
    resetServer({ password: 'server-side-password' })
    const adapter = smtpEmail({
      username: 'billing@example.com',
      defaultFromAddress: 'billing@example.com',
    })({ payload: payload().payload })
    const error = await caught(adapter.sendEmail({ to: 'a@example.com', text: 'hello' }))
    expect(error).toBeInstanceOf(EmailSendError)
    expect(error.provider).toBe('smtp')
    expect(error.message).not.toContain('correct-horse')
  })
})
