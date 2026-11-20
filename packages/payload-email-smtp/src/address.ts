import { EmailSendError } from './errors'
import type { MessageAddress, SmtpAddress } from './types'

const NAMED = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/
const INVALID_ADDR_SPEC = /[<>\s]/

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Parse `Name <a@b.c>` into its parts; a bare address returns no name. */
export const parseAddress = (value: MessageAddress): { name: string; email: string } => {
  if (typeof value !== 'string') return { name: value.name ?? '', email: value.address ?? '' }
  const match = NAMED.exec(value)
  return match ? { name: match[1]?.trim() ?? '', email: match[2]?.trim() ?? '' } : { name: '', email: value }
}

const invalid = (field: string, part: 'address' | 'display name'): EmailSendError =>
  new EmailSendError('smtp', `invalid ${part} in \`${field}\``)

/**
 * Validate one address before it reaches an SMTP command or header. The error names only the
 * field, never the address, so a rejected payload cannot be reflected back into logs or errors.
 */
export const assertValidAddress = (value: MessageAddress, field: string): void => {
  const { name, email } = parseAddress(value)
  if (hasControlCharacter(name)) throw invalid(field, 'display name')
  if (hasControlCharacter(email) || INVALID_ADDR_SPEC.test(email)) throw invalid(field, 'address')

  const at = email.indexOf('@')
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) throw invalid(field, 'address')
}

/** Display names and the subject are header values too: reject raw control characters. */
export const assertValidHeaderValue = (value: string, field: string): void => {
  if (hasControlCharacter(value)) throw new EmailSendError('smtp', `invalid header value in \`${field}\``)
}

/** Split a parsed address into worker-mailer's `{ name?, email }` shape, leaving the email untouched. */
export const toSmtpAddress = (value: MessageAddress): SmtpAddress => {
  const { name, email } = parseAddress(value)
  return name ? { name, email } : { email }
}
