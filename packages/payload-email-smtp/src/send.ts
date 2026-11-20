import { toBase64 } from './bytes'
import { EmailSendError, redact } from './errors'
import { getHeader, mapToSmtpEnvelope } from './map'
import { getAccessToken } from './oauth'
import { sendViaWorkerMailer } from './transport'
import type { EmailMessageInput, SmtpConfig, SmtpConnectionOptions, SmtpCredentials } from './types'
import { sendViaXoauth2 } from './xoauth2'

const toConnectionOptions = (config: SmtpConfig, credentials: SmtpCredentials): SmtpConnectionOptions => ({
  host: config.host,
  port: config.port,
  secure: config.secure === 'tls',
  startTls: config.secure === 'starttls',
  credentials,
})

const secretForms = (values: readonly (string | undefined)[]): string[] => {
  const forms: string[] = []
  for (const value of values) {
    if (!value) continue
    forms.push(value)
    try {
      forms.push(toBase64(new TextEncoder().encode(value)))
    } catch {
      // The raw form is still redacted if the runtime cannot encode.
    }
  }
  return forms
}

/** Never let a redaction failure replace the SMTP server's response. */
const toSmtpError = (error: unknown, secrets: readonly (string | undefined)[]): EmailSendError => {
  if (error instanceof EmailSendError) return error
  const reason = error instanceof Error ? error.message : 'send failed'
  return new EmailSendError('smtp', redact(reason, secretForms(secrets)))
}

const resolveCredentials = async (config: SmtpConfig): Promise<SmtpCredentials> => {
  if ((config.auth ?? 'password') === 'xoauth2') {
    if (!config.oauth) throw new EmailSendError('adapter', 'xoauth2 auth requires the `oauth` option')
    const accessToken = await getAccessToken(config.oauth)
    return { type: 'xoauth2', username: config.username, accessToken }
  }
  if (!config.password) throw new EmailSendError('adapter', 'password auth requires a password')
  return { type: 'password', username: config.username, password: config.password }
}

/**
 * Send one email over SMTP.
 *
 * `secure: 'starttls'` upgrades a plaintext connection on 587; `'tls'` uses implicit TLS on 465.
 * `auth: 'xoauth2'` exchanges the refresh token for an access token and authenticates with SASL
 * XOAUTH2; the default `'password'` uses the SMTP password. Returns the `Message-ID` set on the
 * message (see `mapToSmtpEnvelope`).
 */
export const sendViaSmtp = async (config: SmtpConfig, message: EmailMessageInput): Promise<string> => {
  const envelope = mapToSmtpEnvelope(config, message)
  const messageId = getHeader(envelope.headers, 'Message-ID') ?? ''
  const secrets: (string | undefined)[] = [
    config.password,
    config.oauth?.clientId,
    config.oauth?.clientSecret,
    config.oauth?.refreshToken,
  ]
  try {
    const credentials = await resolveCredentials(config)
    if (credentials.type === 'xoauth2') secrets.push(credentials.accessToken)
    const options = toConnectionOptions(config, credentials)
    if (credentials.type === 'xoauth2') await sendViaXoauth2(options, envelope)
    else await sendViaWorkerMailer(options, envelope)
  } catch (error) {
    throw toSmtpError(error, secrets)
  }
  return messageId
}
