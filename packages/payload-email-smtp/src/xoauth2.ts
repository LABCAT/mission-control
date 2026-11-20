import { toBase64 } from './bytes'
import { ensureBase64Support } from './polyfill'
import type { SocketLike } from './sockets'
import type { SmtpConnectionOptions, SmtpEnvelope } from './types'

const CONNECT_TIMEOUT_MS = 60_000
const RESPONSE_TIMEOUT_MS = 30_000
const EHLO_NAME = 'payload-email-smtp.local'

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])

/**
 * Send with SASL XOAUTH2. worker-mailer 1.3.1 has no XOAUTH2 support, so this speaks the
 * SMTP conversation directly over `cloudflare:sockets` and reuses worker-mailer's `Email`
 * class for the MIME body (same headers/encoding as the password path).
 */
export const sendViaXoauth2 = async (options: SmtpConnectionOptions, email: SmtpEnvelope): Promise<void> => {
  if (options.credentials.type !== 'xoauth2') {
    throw new Error('XOAUTH2 transport requires an access token')
  }

  ensureBase64Support()
  const { Email } = await import('worker-mailer')
  const { connect } = await import('./sockets')
  const body = new Email(email).getEmailData()

  let socket: SocketLike = connect(
    { hostname: options.host, port: options.port },
    {
      secureTransport: options.secure ? 'on' : options.startTls ? 'starttls' : 'off',
      allowHalfOpen: false,
    },
  )
  await withTimeout(socket.opened, CONNECT_TIMEOUT_MS, 'Socket timeout while connecting to the SMTP server')

  let reader = socket.readable.getReader()
  let writer = socket.writable.getWriter()
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let buffer = ''

  const read = async (): Promise<string> => {
    for (;;) {
      const { value, done } = await withTimeout(
        reader.read(),
        RESPONSE_TIMEOUT_MS,
        'Timeout while waiting for the SMTP server response',
      )
      if (done) throw new Error('SMTP connection closed by server')
      if (!value) continue
      buffer += decoder.decode(value, { stream: true })
      if (!buffer.endsWith('\n')) continue
      const lines = buffer.split(/\r?\n/)
      const last = lines[lines.length - 2]
      if (!/^\d+-/.test(last ?? '')) {
        const response = buffer
        buffer = ''
        return response
      }
    }
  }

  const write = async (text: string): Promise<void> => {
    await withTimeout(writer.write(encoder.encode(text)), RESPONSE_TIMEOUT_MS, 'Timeout while writing to the SMTP server')
  }
  const writeLine = (line: string) => write(`${line}\r\n`)
  const expect = async (codes: readonly string[], label: string): Promise<string> => {
    const response = await read()
    if (!codes.includes(response.slice(0, 3))) throw new Error(`${label}: ${response.trim()}`)
    return response
  }

  try {
    await expect(['220'], 'Failed to connect to the SMTP server')
    await writeLine(`EHLO ${EHLO_NAME}`)
    await expect(['250'], 'EHLO failed')

    if (options.startTls) {
      await writeLine('STARTTLS')
      await expect(['220'], 'STARTTLS failed')
      reader.releaseLock()
      writer.releaseLock()
      socket = socket.startTls()
      reader = socket.readable.getReader()
      writer = socket.writable.getWriter()
      await writeLine(`EHLO ${EHLO_NAME}`)
      await expect(['250'], 'EHLO after STARTTLS failed')
    }

    const sasl = toBase64(
      encoder.encode(
        `user=${options.credentials.username}\x01auth=Bearer ${options.credentials.accessToken}\x01\x01`,
      ),
    )
    await writeLine(`AUTH XOAUTH2 ${sasl}`)
    const auth = await read()
    if (auth.startsWith('334')) {
      // Google returns a 334 challenge on failure; an empty line cancels it and yields the 535.
      await writeLine('')
      const failure = await read()
      throw new Error(`XOAUTH2 authentication failed: ${failure.trim()}`)
    }
    if (!auth.startsWith('235')) throw new Error(`XOAUTH2 authentication failed: ${auth.trim()}`)

    await writeLine(`MAIL FROM: <${email.from.email}>`)
    await expect(['250'], 'MAIL FROM failed')
    for (const recipient of [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]) {
      await writeLine(`RCPT TO: <${recipient.email}>`)
      await expect(['250', '251'], 'RCPT TO failed')
    }

    await writeLine('DATA')
    await expect(['354'], 'DATA failed')
    await write(body)
    await expect(['250'], 'Sending the message body failed')

    await writeLine('QUIT')
    try {
      await read()
    } catch {
      // The server may close before replying to QUIT; the message is already accepted.
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released after STARTTLS or closed by the server.
    }
    try {
      writer.releaseLock()
    } catch {
      // Already released after STARTTLS or closed by the server.
    }
    try {
      await socket.close()
    } catch {
      // Best effort.
    }
  }
}
