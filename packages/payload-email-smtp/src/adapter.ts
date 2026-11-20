import type { PayloadEmailAdapter } from 'payload'

import { EmailSendError } from './errors'
import { sendViaSmtp } from './send'
import type { EmailMessageInput, SmtpAuthMode, SmtpConfig, SmtpSecureTransport } from './types'

export type SmtpEmailOptions = {
  /** SMTP host. Default `smtp.gmail.com` (Google Workspace). */
  host?: string
  /** SMTP port. Default `587` (STARTTLS); use `465` with `secure: 'tls'`. */
  port?: number
  /** `'starttls'` (587) or `'tls'` (465). Default `'starttls'`. */
  secure?: SmtpSecureTransport
  /** SMTP username. For Google Workspace this is the sending account. */
  username?: string
  /** `'password'` (default) or `'xoauth2'`. */
  auth?: SmtpAuthMode
  /**
   * Name of the env var or Worker secret holding the password. Default `SMTP_PASSWORD`.
   * The password is read at send time: it is never stored in options, config or the DB.
   */
  passwordEnv?: string
  /** XOAUTH2 client ID env/secret name. Default `SMTP_OAUTH_CLIENT_ID`. */
  oauthClientIdEnv?: string
  /** XOAUTH2 client secret env/secret name. Default `SMTP_OAUTH_CLIENT_SECRET`. */
  oauthClientSecretEnv?: string
  /** XOAUTH2 refresh token env/secret name. Default `SMTP_OAUTH_REFRESH_TOKEN`. */
  oauthRefreshTokenEnv?: string
  /** Token endpoint. Default `https://oauth2.googleapis.com/token`. */
  oauthTokenEndpoint?: string
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

const readSecret = (env: EnvBag, name: string): string => {
  const value = env[name]
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

const connectionConfig = (options: SmtpEmailOptions): Omit<SmtpConfig, 'auth' | 'password' | 'oauth'> => ({
  host: options.host ?? 'smtp.gmail.com',
  port: options.port ?? 587,
  secure: options.secure ?? 'starttls',
  username: options.username ?? '',
  fromAddress: options.defaultFromAddress ?? '',
  fromName: options.defaultFromName,
})

/**
 * Payload email adapter over SMTP (Google Workspace by default).
 *
 * - `username` and the password or OAuth secrets present: sends over SMTP.
 * - `transport: 'console'`, or unconfigured outside Workers: logs that nothing was sent,
 *   without recipients, subject or body.
 * - Unconfigured inside Workers: throws.
 *
 * Secrets are read from env/secret names at send time and are never stored or logged.
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

      const auth = options.auth ?? 'password'
      const env = await readEnv()

      if (auth === 'xoauth2') {
        const clientIdName = options.oauthClientIdEnv ?? 'SMTP_OAUTH_CLIENT_ID'
        const clientSecretName = options.oauthClientSecretEnv ?? 'SMTP_OAUTH_CLIENT_SECRET'
        const refreshTokenName = options.oauthRefreshTokenEnv ?? 'SMTP_OAUTH_REFRESH_TOKEN'
        const clientId = readSecret(env, clientIdName)
        const clientSecret = readSecret(env, clientSecretName)
        const refreshToken = readSecret(env, refreshTokenName)
        if (!options.username || !clientId || !clientSecret || !refreshToken) {
          if (isWorkersRuntime()) {
            throw new EmailSendError(
              'smtp',
              `SMTP is not configured; set the username and the ${clientIdName}, ${clientSecretName} and ${refreshTokenName} secrets`,
            )
          }
          logNotSent(payload)
          return
        }
        const messageId = await sendViaSmtp(
          {
            ...connectionConfig(options),
            auth: 'xoauth2',
            oauth: {
              clientId,
              clientSecret,
              refreshToken,
              ...(options.oauthTokenEndpoint ? { tokenEndpoint: options.oauthTokenEndpoint } : {}),
            },
          },
          message,
        )
        return { messageId }
      }

      const passwordName = options.passwordEnv ?? 'SMTP_PASSWORD'
      const password = readSecret(env, passwordName)
      if (!options.username || !password) {
        if (isWorkersRuntime()) {
          throw new EmailSendError(
            'smtp',
            `SMTP is not configured; set the username and the ${passwordName} secret`,
          )
        }
        logNotSent(payload)
        return
      }
      const messageId = await sendViaSmtp({ ...connectionConfig(options), auth: 'password', password }, message)
      return { messageId }
    },
  })
