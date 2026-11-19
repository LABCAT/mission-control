import { toSmtpAddress } from './address'
import { toBase64, toBytes } from './bytes'
import { encodeHeader } from './encoding'
import { EmailSendError } from './errors'
import type {
  EmailAttachmentInput,
  EmailMessageInput,
  MessageAddress,
  Recipients,
  SmtpAddress,
  SmtpAttachment,
  SmtpConfig,
  SmtpEnvelope,
} from './types'

const mapAddress = (value: MessageAddress): SmtpAddress => {
  const address = toSmtpAddress(value)
  return address.name ? { name: encodeHeader(address.name), email: address.email } : address
}

const mapRecipients = (value: Recipients | undefined): SmtpAddress[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(mapAddress)

const mapAttachment = (attachment: EmailAttachmentInput): SmtpAttachment => {
  if (attachment.path !== undefined || attachment.href !== undefined) {
    throw new EmailSendError('adapter', 'attachments must carry inline `content`; `path`/`href` are not supported')
  }
  return {
    filename: attachment.filename ?? 'attachment',
    content: toBase64(toBytes(attachment)),
    ...(attachment.contentType ? { mimeType: attachment.contentType } : {}),
  }
}

const messageIdDomain = (from: SmtpAddress): string => from.email.split('@')[1]?.trim() || 'localhost'

const hasHeader = (headers: Record<string, string>, name: string): boolean =>
  Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())

/**
 * Build worker-mailer's message shape from a Payload/nodemailer message.
 *
 * The `Message-ID` header is set here (and returned by `sendViaSmtp`) because worker-mailer
 * reports only success, not the server's `250` queue id. This mirrors nodemailer's
 * `info.messageId`, which is also client-generated.
 */
export const mapToSmtpEnvelope = (config: SmtpConfig, message: EmailMessageInput): SmtpEnvelope => {
  const from = mapAddress(
    message.from ?? {
      ...(config.fromName ? { name: config.fromName } : {}),
      address: config.fromAddress,
    },
  )
  const headers = { ...message.headers }
  if (!hasHeader(headers, 'Message-ID')) {
    headers['Message-ID'] = `<${crypto.randomUUID()}@${messageIdDomain(from)}>`
  }
  return {
    from,
    to: mapRecipients(message.to),
    ...(message.cc !== undefined ? { cc: mapRecipients(message.cc) } : {}),
    ...(message.bcc !== undefined ? { bcc: mapRecipients(message.bcc) } : {}),
    ...(message.replyTo !== undefined ? { reply: mapAddress(message.replyTo) } : {}),
    subject: encodeHeader(message.subject ?? ''),
    ...(typeof message.text === 'string' ? { text: message.text } : {}),
    ...(typeof message.html === 'string' ? { html: message.html } : {}),
    headers,
    ...(message.attachments?.length ? { attachments: message.attachments.map(mapAttachment) } : {}),
  }
}
