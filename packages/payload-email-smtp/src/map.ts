import { assertValidAddress, sanitizeHeaderValue, toSmtpAddress } from './address'
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

const HEADER_NAME = /^[\w!#$%&'*+.^`|~-]+$/

const mapAddress = (value: MessageAddress): SmtpAddress => {
  const address = toSmtpAddress(value)
  return address.name ? { name: encodeHeader(address.name), email: address.email } : address
}

const mapRecipients = (value: Recipients | undefined): SmtpAddress[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).map(mapAddress)

const assertValidRecipients = (value: Recipients | undefined, field: string): void => {
  if (value === undefined) return
  for (const address of Array.isArray(value) ? value : [value]) assertValidAddress(address, field)
}

const mapAttachment = (attachment: EmailAttachmentInput): SmtpAttachment => {
  if (attachment.path !== undefined || attachment.href !== undefined) {
    throw new EmailSendError('adapter', 'attachments must carry inline `content`; `path`/`href` are not supported')
  }
  return {
    filename: sanitizeHeaderValue(attachment.filename ?? 'attachment') || 'attachment',
    content: toBase64(toBytes(attachment)),
    ...(attachment.contentType && sanitizeHeaderValue(attachment.contentType)
      ? { mimeType: sanitizeHeaderValue(attachment.contentType) }
      : {}),
  }
}

const messageIdDomain = (from: SmtpAddress): string => from.email.split('@')[1]?.trim() || 'localhost'

/** Case-insensitive header lookup, so `message-id` and `MESSAGE-ID` behave like `Message-ID`. */
export const getHeader = (headers: Record<string, string>, name: string): string | undefined => {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return undefined
}

/**
 * Collapse every case variant of `Message-ID` into one exact key, keeping the caller's value.
 * Callers cannot cause two Message-ID headers to be sent.
 */
const normalizeMessageId = (headers: Record<string, string>, domain: string): Record<string, string> => {
  const normalized: Record<string, string> = {}
  let messageId: string | undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'message-id') {
      const clean = sanitizeHeaderValue(value)
      if (!messageId && clean) messageId = clean
      continue
    }
    if (!HEADER_NAME.test(key)) throw new EmailSendError('smtp', 'invalid header name')
    normalized[key] = sanitizeHeaderValue(value)
  }
  normalized['Message-ID'] = messageId ?? `<${crypto.randomUUID()}@${domain}>`
  return normalized
}

/**
 * Build worker-mailer's message shape from a Payload/nodemailer message.
 *
 * The `Message-ID` header is set here (and returned by `sendViaSmtp`) because worker-mailer
 * reports only success, not the server's `250` queue id. This mirrors nodemailer's
 * `info.messageId`, which is also client-generated.
 */
export const mapToSmtpEnvelope = (config: SmtpConfig, message: EmailMessageInput): SmtpEnvelope => {
  const fromValue =
    message.from ?? {
      ...(config.fromName ? { name: config.fromName } : {}),
      address: config.fromAddress,
    }
  assertValidAddress(fromValue, 'from')
  assertValidRecipients(message.to, 'to')
  assertValidRecipients(message.cc, 'cc')
  assertValidRecipients(message.bcc, 'bcc')
  if (message.replyTo !== undefined) assertValidAddress(message.replyTo, 'replyTo')

  const from = mapAddress(fromValue)
  const headers = normalizeMessageId({ ...message.headers }, messageIdDomain(from))
  return {
    from,
    to: mapRecipients(message.to),
    ...(message.cc !== undefined ? { cc: mapRecipients(message.cc) } : {}),
    ...(message.bcc !== undefined ? { bcc: mapRecipients(message.bcc) } : {}),
    ...(message.replyTo !== undefined ? { reply: mapAddress(message.replyTo) } : {}),
    subject: encodeHeader(sanitizeHeaderValue(message.subject ?? '')),
    ...(typeof message.text === 'string' ? { text: message.text } : {}),
    ...(typeof message.html === 'string' ? { html: message.html } : {}),
    headers,
    ...(message.attachments?.length ? { attachments: message.attachments.map(mapAttachment) } : {}),
  }
}
