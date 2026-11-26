import type { PayloadEmailAdapter } from 'payload'

import { mapToCloudflareMessage } from './cloudflare'
import { EmailSendError } from './errors'
import { applyRedirect, type RedirectOption } from './redirect'
import { sendViaResend } from './resend'
import type { EmailMessageInput, MessageAddress, SendEmailBinding } from './types'

export type ResendOptions = {
  /** API key. Defaults to the `RESEND_API_KEY` secret/env var. Never logged or put in errors. */
  apiKey?: string | (() => string | undefined)
  /** Override for tests or a proxy. Default `https://api.resend.com/emails`. */
  endpoint?: string
  /** Custom fetch. Default global `fetch`. */
  fetch?: typeof fetch
}

export type CloudflareEmailOptions = {
  /** Used when a message has no `from`. Per-call `from` always wins. */
  defaultFromAddress?: string
  defaultFromName?: string
  /** Name of the `send_email` binding in wrangler config. Default `EMAIL`. */
  bindingName?: string
  /** Provide the binding directly (tests, non-Workers hosts) instead of reading it from the Workers env. */
  binding?: SendEmailBinding | (() => SendEmailBinding | undefined)
  /** `'resend'` skips the binding and sends through Resend. Default `'cloudflare'`. */
  provider?: 'cloudflare' | 'resend'
  /** Force the console transport: log that an email was sent, deliver nothing. */
  transport?: 'console'
  /** Fallback used when the binding is missing, or when `provider: 'resend'`. */
  resend?: ResendOptions
  /**
   * Redirect-all, for previews and staging. When it resolves to a config, every message's
   * to/cc/bcc is replaced by `to` and the subject is prefixed with the original recipients.
   * With no `to`, nothing is delivered (console). Resolve it per send, not at module scope.
   */
  redirect?: RedirectOption
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

const logNotSent = (payload: Parameters<PayloadEmailAdapter>[0]['payload']) =>
  payload.logger.info({
    msg: 'Email not sent (console transport: no Cloudflare Email Sending binding available).',
  })

const defaultFrom = (options: CloudflareEmailOptions): MessageAddress => ({
  ...(options.defaultFromName ? { name: options.defaultFromName } : {}),
  address: options.defaultFromAddress ?? '',
})

/**
 * Payload email adapter for the Workers `send_email` binding.
 *
 * - Binding present: sends through Cloudflare Email Sending.
 * - Binding missing (or `provider: 'resend'`) and `resend` configured: sends through Resend.
 * - Neither, outside Workers (or `transport: 'console'`): logs that nothing was sent, without
 *   recipients, subject or body.
 * - Neither, inside Workers: throws.
 */
export const cloudflareEmail =
  (options: CloudflareEmailOptions = {}): PayloadEmailAdapter =>
  ({ payload }) => ({
    name: 'cloudflare-email-sending',
    defaultFromAddress: options.defaultFromAddress ?? '',
    defaultFromName: options.defaultFromName ?? '',
    async sendEmail(raw) {
      let message = { ...(raw as EmailMessageInput) }
      if (!message.from || (typeof message.from === 'string' && message.from === '')) {
        message.from = defaultFrom(options)
      }

      // Redirect-all runs before any transport, so Cloudflare, Resend and every future path
      // see only the safe inbox. A missing inbox never delivers.
      const redirect = typeof options.redirect === 'function' ? await options.redirect() : options.redirect
      if (redirect) {
        const inbox = redirect.to?.trim()
        if (!inbox) {
          return payload.logger.info({
            msg: 'Email not sent (redirect is on but no redirect inbox is configured).',
          })
        }
        message = applyRedirect(message, inbox, redirect.label?.trim() || 'non-production')
      }

      if (options.transport === 'console') return logNotSent(payload)

      const useResend = async () => {
        const configured = options.resend
        const env = configured?.apiKey === undefined ? await readEnv() : {}
        const key =
          typeof configured?.apiKey === 'function'
            ? configured.apiKey()
            : (configured?.apiKey ?? (env.RESEND_API_KEY as string | undefined))
        if (!key) throw new EmailSendError('resend', 'no API key configured (set RESEND_API_KEY)')
        await sendViaResend(
          message,
          key,
          configured?.endpoint ?? 'https://api.resend.com/emails',
          configured?.fetch ?? fetch,
        )
      }

      if (options.provider === 'resend') {
        if (!options.resend) throw new EmailSendError('adapter', "provider 'resend' requires the `resend` option")
        return useResend()
      }

      const injected = typeof options.binding === 'function' ? options.binding() : options.binding
      const binding =
        injected ??
        (isWorkersRuntime()
          ? ((await readEnv())[options.bindingName ?? 'EMAIL'] as SendEmailBinding | undefined)
          : undefined)

      if (binding) {
        try {
          const result = await (binding as { send(m: unknown): Promise<unknown> }).send(mapToCloudflareMessage(message))
          // PJ-107: hand the binding's message id back, so the email log can match delivery events.
          const messageId = (result as { messageId?: unknown } | null | undefined)?.messageId
          return typeof messageId === 'string' && messageId ? { messageId } : undefined
        } catch (error) {
          if (error instanceof EmailSendError) throw error
          // The binding's own message (e.g. unverified sending domain) is safe: it carries no secrets.
          const reason = error instanceof Error ? error.message : 'send failed'
          throw new EmailSendError('cloudflare', reason)
        }
      }

      if (options.resend) return useResend()
      if (isWorkersRuntime()) {
        throw new EmailSendError(
          'cloudflare',
          `binding "${options.bindingName ?? 'EMAIL'}" not found; add it under send_email in wrangler config or configure \`resend\``,
        )
      }
      logNotSent(payload)
    },
  })
