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
  /** Ignored: SMTP over worker-mailer does not emit `Content-ID` inline parts. */
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

export type SmtpSecureTransport = 'starttls' | 'tls'

export type SmtpAuthMode = 'password' | 'xoauth2'

/** Google OAuth credentials for XOAUTH2. Every value is read per send; none is stored by the adapter. */
export type SmtpOauthConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
  /** Default `https://oauth2.googleapis.com/token`. */
  tokenEndpoint?: string
  /** Override `fetch` (proxy or tests). */
  fetch?: typeof fetch
}

/** Where and how to connect, and who to authenticate as. Secrets are passed per call, never stored. */
export type SmtpConfig = {
  host: string
  port: number
  /** `'starttls'` upgrades on 587; `'tls'` is implicit TLS on 465. */
  secure: SmtpSecureTransport
  username: string
  /** Default `'password'`. */
  auth?: SmtpAuthMode
  /** Required for `auth: 'password'`. */
  password?: string
  /** Required for `auth: 'xoauth2'`. */
  oauth?: SmtpOauthConfig
  fromAddress: string
  fromName?: string
}

export type SmtpAddress = { name?: string; email: string }

export type SmtpAttachment = { filename: string; content: string; mimeType?: string }

/** The message shape worker-mailer consumes; attachments are base64 strings. */
export type SmtpEnvelope = {
  from: SmtpAddress
  to: SmtpAddress[]
  reply?: SmtpAddress
  cc?: SmtpAddress[]
  bcc?: SmtpAddress[]
  subject: string
  text?: string
  html?: string
  headers: Record<string, string>
  attachments?: SmtpAttachment[]
}

/** Resolved credentials: the password, or a freshly refreshed XOAUTH2 access token. */
export type SmtpCredentials =
  | { type: 'password'; username: string; password: string }
  | { type: 'xoauth2'; username: string; accessToken: string }

/** Connection options for a transport, before library-specific wrapping. */
export type SmtpConnectionOptions = {
  host: string
  port: number
  secure: boolean
  startTls: boolean
  credentials: SmtpCredentials
}

/** Sends one already-mapped message. The default uses worker-mailer over `cloudflare:sockets`. */
export type SmtpTransport = {
  send(options: SmtpConnectionOptions, email: SmtpEnvelope): Promise<void>
}
