import { toCloudflareAddress } from './address'
import { toBytes } from './bytes'
import type {
  CloudflareAttachment,
  CloudflareEmailMessage,
  EmailAttachmentInput,
  EmailMessageInput,
  Recipients,
} from './types'
import { EmailSendError } from './errors'

const mapRecipients = (value: Recipients | undefined) =>
  value === undefined
    ? undefined
    : Array.isArray(value)
      ? value.map(toCloudflareAddress)
      : toCloudflareAddress(value)

const mapAttachment = (attachment: EmailAttachmentInput): CloudflareAttachment => {
  if (attachment.path !== undefined || attachment.href !== undefined) {
    throw new EmailSendError('adapter', 'attachments must carry inline `content`; `path`/`href` are not supported')
  }
  const filename = attachment.filename ?? 'attachment'
  const type = attachment.contentType ?? 'application/octet-stream'
  // Strings are passed as-is unless base64-encoded; everything else goes through as bytes.
  const content =
    typeof attachment.content === 'string' && attachment.encoding !== 'base64'
      ? attachment.content
      : toBytes(attachment)
  if (attachment.cid) {
    return { disposition: 'inline', contentId: attachment.cid, filename, type, content }
  }
  return { disposition: 'attachment', filename, type, content }
}

/**
 * Build the structured message the `send_email` binding expects from a Payload/nodemailer
 * message. nodemailer calls an address `address`; the binding calls it `email`.
 */
export const mapToCloudflareMessage = (message: EmailMessageInput): CloudflareEmailMessage => ({
  from: toCloudflareAddress(message.from ?? ''),
  subject: message.subject ?? '',
  to: mapRecipients(message.to) ?? '',
  ...(message.cc !== undefined ? { cc: mapRecipients(message.cc) } : {}),
  ...(message.bcc !== undefined ? { bcc: mapRecipients(message.bcc) } : {}),
  ...(message.replyTo !== undefined ? { replyTo: toCloudflareAddress(message.replyTo) } : {}),
  ...(typeof message.html === 'string' ? { html: message.html } : {}),
  ...(typeof message.text === 'string' ? { text: message.text } : {}),
  ...(message.headers ? { headers: message.headers } : {}),
  ...(message.attachments?.length ? { attachments: message.attachments.map(mapAttachment) } : {}),
})
