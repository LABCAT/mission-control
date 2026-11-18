/** An address as nodemailer/Payload spell it: a string (`a@b.c` or `Name <a@b.c>`) or `{ name, address }`. */
export type MessageAddress = string | { name?: string; address?: string }

export type Recipients = MessageAddress | MessageAddress[]

/** The subset of a nodemailer attachment the adapter supports (inline content only, no `path`/`href`). */
export type EmailAttachmentInput = {
  filename?: string
  content?: string | ArrayBuffer | ArrayBufferView
  /** Only `'base64'` is understood for string content; anything else is treated as UTF-8 text. */
  encoding?: string
  contentType?: string
  /** Content-ID: marks the attachment as inline (`cid:` reference in the HTML). */
  cid?: string
  contentDisposition?: 'attachment' | 'inline'
  /** Unsupported: remote/file attachments are rejected rather than silently dropped. */
  path?: unknown
  href?: unknown
}

/** The subset of a Payload/nodemailer message the adapter handles. */
export type EmailMessageInput = {
  from?: MessageAddress
  to?: Recipients
  cc?: Recipients
  bcc?: Recipients
  replyTo?: MessageAddress
  subject?: string
  html?: string
  text?: string
  headers?: Record<string, string>
  attachments?: EmailAttachmentInput[]
}

export type CloudflareEmailAddress = { name: string; email: string }

type CloudflareRecipients = string | CloudflareEmailAddress | (string | CloudflareEmailAddress)[]

export type CloudflareAttachment = {
  disposition: 'inline' | 'attachment'
  contentId?: string
  filename: string
  type: string
  content: string | ArrayBuffer | ArrayBufferView
}

/** The structured message the Workers `send_email` binding accepts (`EmailMessageBuilder`). */
export type CloudflareEmailMessage = {
  from: string | CloudflareEmailAddress
  subject: string
  to?: CloudflareRecipients
  cc?: CloudflareRecipients
  bcc?: CloudflareRecipients
  replyTo?: string | CloudflareEmailAddress
  headers?: Record<string, string>
  text?: string
  html?: string
  attachments?: CloudflareAttachment[]
}

/** Structural type for the Workers `send_email` binding (`SendEmail`). */
export type SendEmailBinding = {
  send(message: never): Promise<unknown>
}
