export { smtpEmail } from './adapter'
export type { SmtpEmailOptions } from './adapter'
export { sendViaSmtp } from './send'
export { mapToSmtpEnvelope } from './map'
export { encodeHeader } from './encoding'
export { EmailSendError } from './errors'
export type {
  EmailAttachmentInput,
  EmailMessageInput,
  MessageAddress,
  Recipients,
  SmtpAddress,
  SmtpAttachment,
  SmtpAuthMode,
  SmtpConfig,
  SmtpConnectionOptions,
  SmtpCredentials,
  SmtpEnvelope,
  SmtpOauthConfig,
  SmtpSecureTransport,
  SmtpTransport,
} from './types'
