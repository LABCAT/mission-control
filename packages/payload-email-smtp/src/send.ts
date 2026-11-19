import { toBase64 } from './bytes'
import { EmailSendError, redact } from './errors'
import { mapToSmtpEnvelope } from './map'
import { sendViaWorkerMailer } from './transport'
import type { EmailMessageInput, SmtpConfig, SmtpConnectionOptions } from './types'

const toConnectionOptions = (config: SmtpConfig): SmtpConnectionOptions => ({
  host: config.host,
  port: config.port,
  secure: config.secure === 'tls',
  startTls: config.secure === 'starttls',
  credentials: { username: config.username, password: config.password },
  authType: ['plain', 'login', 'cram-md5'],
})

const toSmtpError = (error: unknown, password: string): EmailSendError => {
  if (error instanceof EmailSendError) return error
  const reason = error instanceof Error ? error.message : 'send failed'
  // Some servers echo the submitted credential back; scrub the raw and base64 forms.
  const encoded = toBase64(new TextEncoder().encode(password))
  return new EmailSendError('smtp', redact(reason, [password, encoded]))
}

/**
 * Send one email over SMTP.
 *
 * `secure: 'starttls'` upgrades a plaintext connection on 587; `'tls'` uses implicit TLS on 465.
 * Returns the `Message-ID` set on the message (see `mapToSmtpEnvelope`).
 */
export const sendViaSmtp = async (config: SmtpConfig, message: EmailMessageInput): Promise<string> => {
  const envelope = mapToSmtpEnvelope(config, message)
  const messageId = envelope.headers['Message-ID'] ?? ''
  try {
    await sendViaWorkerMailer(toConnectionOptions(config), envelope)
  } catch (error) {
    throw toSmtpError(error, config.password)
  }
  return messageId
}
