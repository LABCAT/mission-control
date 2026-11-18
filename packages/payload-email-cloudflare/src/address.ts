import type { CloudflareEmailAddress, MessageAddress } from './types'

const NAMED = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/

/** Parse `Name <a@b.c>` into its parts; a bare address returns no name. */
export const parseAddress = (value: MessageAddress): { name: string; email: string } => {
  if (typeof value !== 'string') return { name: value.name ?? '', email: value.address ?? '' }
  const match = NAMED.exec(value)
  return match ? { name: match[1]?.trim() ?? '', email: match[2]?.trim() ?? '' } : { name: '', email: value }
}

/** Cloudflare shape. A bare string passes through unchanged. */
export const toCloudflareAddress = (value: MessageAddress): string | CloudflareEmailAddress => {
  if (typeof value === 'string' && !NAMED.test(value)) return value
  return parseAddress(value)
}

/** `Name <a@b.c>` or `a@b.c`, for HTTP providers. */
export const toDisplayAddress = (value: MessageAddress): string => {
  const { name, email } = parseAddress(value)
  return name ? `${name.replace(/[<>"]/g, '')} <${email}>` : email
}
