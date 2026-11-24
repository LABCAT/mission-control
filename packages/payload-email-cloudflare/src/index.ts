export { cloudflareEmail } from './adapter'
export type { CloudflareEmailOptions, ResendOptions } from './adapter'
export { applyRedirect, redirectSubject } from './redirect'
export type { RedirectConfig, RedirectOption } from './redirect'
export { EmailSendError } from './errors'
export { mapToCloudflareMessage } from './cloudflare'
export { mapToResendPayload } from './resend'
export type {
  CloudflareEmailAddress,
  CloudflareEmailMessage,
  EmailAttachmentInput,
  EmailMessageInput,
  SendEmailBinding,
} from './types'
