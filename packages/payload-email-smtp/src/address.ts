import type { MessageAddress, SmtpAddress } from './types'

const NAMED = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/

/** Parse `Name <a@b.c>` into its parts; a bare address returns no name. */
export const parseAddress = (value: MessageAddress): { name: string; email: string } => {
  if (typeof value !== 'string') return { name: value.name ?? '', email: value.address ?? '' }
  const match = NAMED.exec(value)
  return match ? { name: match[1]?.trim() ?? '', email: match[2]?.trim() ?? '' } : { name: '', email: value }
}

/** Split a parsed address into worker-mailer's `{ name?, email }` shape, leaving the email untouched. */
export const toSmtpAddress = (value: MessageAddress): SmtpAddress => {
  const { name, email } = parseAddress(value)
  return name ? { name, email } : { email }
}
