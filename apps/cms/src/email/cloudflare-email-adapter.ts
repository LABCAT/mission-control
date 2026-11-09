import type { PayloadEmailAdapter } from 'payload'

/**
 * The subset of a Payload/nodemailer message the adapter handles. An address is a plain
 * string or a `{ name, address }` object; a recipient field is one address or an array.
 */
type MessageAddress = string | { name?: string; address?: string }

type Recipients = MessageAddress | MessageAddress[]

type EmailMessage = {
  from?: MessageAddress
  to: Recipients
  cc?: Recipients
  bcc?: Recipients
  replyTo?: MessageAddress
  subject?: string
  html?: string
  text?: string
  headers?: Record<string, string>
}

// The send_email binding and its `EmailMessageBuilder` / `EmailAddress` types come from the
// generated worker-configuration.d.ts, so this adapter lives in the cms Worker, not in a package.

const isWorkersRuntime = (): boolean =>
  typeof globalThis.navigator !== 'undefined' && globalThis.navigator?.userAgent === 'Cloudflare-Workers'

/**
 * Map a nodemailer-style address to the Cloudflare Email Sending shape. nodemailer calls the
 * field `address`; the Workers binding calls it `email`.
 */
const toCloudflareAddress = (value: MessageAddress): string | EmailAddress =>
  typeof value === 'string'
    ? value
    : { name: value.name ?? '', email: value.address ?? '' }

const toCloudflareRecipients = (
  value: Recipients | undefined,
): string | EmailAddress | (string | EmailAddress)[] | undefined =>
  value === undefined
    ? undefined
    : Array.isArray(value)
      ? value.map(toCloudflareAddress)
      : toCloudflareAddress(value)

/**
 * Build the structured message the `send_email` binding expects from a Payload/nodemailer
 * message. Every caller provides `to` (the binding also requires at least one recipient).
 */
export const mapToCloudflareEmailMessage = (message: EmailMessage): EmailMessageBuilder => ({
  from: toCloudflareAddress(message.from ?? ''),
  subject: message.subject ?? '',
  to: toCloudflareRecipients(message.to) ?? '',
  ...(message.cc !== undefined ? { cc: toCloudflareRecipients(message.cc) } : {}),
  ...(message.bcc !== undefined ? { bcc: toCloudflareRecipients(message.bcc) } : {}),
  ...(message.replyTo !== undefined ? { replyTo: toCloudflareAddress(message.replyTo) } : {}),
  ...(typeof message.html === 'string' ? { html: message.html } : {}),
  ...(typeof message.text === 'string' ? { text: message.text } : {}),
  ...(message.headers ? { headers: message.headers } : {}),
})

/**
 * A Payload email adapter that sends through the Cloudflare Email Sending binding in Workers
 * and logs to the console in dev (where there is no binding). Production sending stays gated
 * behind PJ-03: until a sending domain is provisioned the binding rejects sends, and nothing
 * here provisions or unblocks one.
 */
export const cloudflareEmailAdapter: PayloadEmailAdapter = ({ payload }) => ({
  name: 'cloudflare-email-sending',
  // Tenant emails always set `from` via sendTenantEmail, so these defaults only back Payload's
  // built-in auth emails (forgot-password / verify), which are wired up in a later task.
  defaultFromAddress: '',
  defaultFromName: '',
  async sendEmail(message) {
    if (!isWorkersRuntime()) {
      // Outside the Workers runtime (Node CLI, vitest) there is no send_email binding, so log
      // instead of sending. In `wrangler dev` the binding itself simulates delivery (logs, no
      // real send). Keep recipient, subject, and body data out of development logs.
      payload.logger.info({
        msg: 'Email not sent (no Cloudflare Email Sending binding outside Workers).',
      })
      return
    }

    const { env } = await import('cloudflare:workers')
    await env.EMAIL.send(mapToCloudflareEmailMessage(message))
  },
})
