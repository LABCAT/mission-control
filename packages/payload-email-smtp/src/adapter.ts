import type { PayloadEmailAdapter } from 'payload'

import { EmailSendError } from './errors'
import { sendViaSmtp } from './send'
import type { EmailMessageInput, SmtpSecureTransport } from './types'

export type SmtpEmailOptions = {
  /** SMTP host. Default `smtp.gmail.com` (Google Workspace). */
  host?: string
  /** SMTP port. Default `587` (STARTTLS); use `465` with `secure: 'tls'`. */
  port?: number
  /** `'starttls'` (587) or `'tls'` (465). Default `'starttls'`. */
  secure?: SmtpSecureTransport
  /** SMTP username. Without it SMTP is treated as unconfigured. */
  username?: string
  /**
   * Name of the env var or Worker secret holding the password. Default `SMTP_PASSWORD`.
   * The password is read at send time: it is never stored in options, config or the DB.
   */
  passwordEnv?: string
  /** Used when a message has no `from`. Per-call `from` always wins. */
  defaultFromAddress?: string
  defaultFromName?: string
  /** Force the console transport: log that an email was sent, deliver nothing. */
  transport?: 'console'
}

const isWorkersRuntime = (): boolean =>
  typeof globalThis.navigator !== 'undefined' && globalThis.navigator?.userAgent === 'Cloudflare-Workers'

type EnvBag = Record<string, unknown>

/** Workers env (bindings and secrets) when available, else `process.env`. */
const readEnv = async (): Promise<EnvBag> => {
  if (isWorkersRuntime()) {
    // @ts-ignore -- `cloudflare:workers` is typed only where worker-configuration.d.ts is present.
    const { env } = (await import('cloudflare:workers')) as { env: EnvBag }
    return env
  }
  return typeof process !== 'undefined' ? (process.env as EnvBag) : {}
}

const readPassword = async (options: SmtpEmailOptions): Promise<string> => {
  const name = options.passwordEnv ?? 'SMTP_PASSWORD'
  const value = (await readEnv())[name]
  return typeof value === 'string' ? value : ''
}

const logNotSent = (payload: Parameters<PayloadEmailAdapter>[0]['payload']) =>
  payload.logger.info({
    msg: 'Email not sent (console transport: SMTP is not configured).',
  })

const defaultFrom = (options: SmtpEmailOptions) => ({
  ...(options.defaultFromName ? { name: options.defaultFromName } : {}),
  address: options.defaultFromAddress ?? '',
})

/**
 * Payload email adapter over SMTP (Google Workspace by default).
 *
 * - `username` and the password secret present: sends over SMTP.
 * - `transport: 'console'`, or unconfigured outside Workers: logs that nothing was sent,
 *   without recipients, subject or body.
 * - Unconfigured inside Workers: throws.
 */
export const smtpEmail =
  (options: SmtpEmailOptions = {}): PayloadEmailAdapter =>
  ({ payload }) => ({
    name: 'smtp',
    defaultFromAddress: options.defaultFromAddress ?? '',
    defaultFromName: options.defaultFromName ?? '',
    async sendEmail(raw) {
      const message = { ...(raw as EmailMessageInput) }
      if (!message.from || (typeof message.from === 'string' && message.from === '')) {
        message.from = defaultFrom(options)
      }

      if (options.transport === 'console') return logNotSent(payload)

      const password = options.username ? await readPassword(options) : ''
      if (!options.username || !password) {
        if (isWorkersRuntime()) {
          throw new EmailSendError(
            'smtp',
            `SMTP is not configured; set the username and the ${options.passwordEnv ?? 'SMTP_PASSWORD'} secret`,
          )
        }
        logNotSent(payload)
        return
      }

      const messageId = await sendViaSmtp(
        {
          host: options.host ?? 'smtp.gmail.com',
          port: options.port ?? 587,
          secure: options.secure ?? 'starttls',
          username: options.username,
          password,
          fromAddress: options.defaultFromAddress ?? '',
          fromName: options.defaultFromName,
        },
        message,
      )
      return { messageId }
    },
  })
