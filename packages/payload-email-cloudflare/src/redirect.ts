import { parseAddress } from './address'
import type { EmailMessageInput, MessageAddress, Recipients } from './types'

/**
 * Redirect-all: send every message to one inbox instead of its real recipients, so previews and
 * staging can never email the public.
 *
 * Returning a config turns the redirect ON. Returning `undefined` leaves delivery untouched
 * (production). With the redirect on but no `to`, nothing is delivered: the adapter falls back to
 * the console transport.
 */
export type RedirectConfig = {
  /** The one inbox that receives everything. Missing or blank means: deliver nothing. */
  to?: string
  /** Shown in the subject prefix, e.g. `preview` gives `[preview → a@x.test] Subject`. Default `non-production`. */
  label?: string
}

export type RedirectOption = RedirectConfig | (() => RedirectConfig | undefined | Promise<RedirectConfig | undefined>)

const toList = (value: Recipients | undefined): MessageAddress[] =>
  value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value]

const emails = (value: Recipients | undefined): string[] =>
  toList(value)
    .map((entry) => parseAddress(entry).email)
    .filter(Boolean)

/** Subject prefix naming the environment and every original to/cc/bcc recipient. */
export const redirectSubject = (message: EmailMessageInput, label: string): string => {
  const to = emails(message.to)
  const cc = emails(message.cc).map((email) => `cc:${email}`)
  const bcc = emails(message.bcc).map((email) => `bcc:${email}`)
  const original = [...to, ...cc, ...bcc].join(', ') || 'no recipients'
  return `[${label} → ${original}] ${message.subject ?? ''}`.trimEnd()
}

/** A copy of `message` addressed only to `inbox`, with cc/bcc removed and the subject prefixed. */
export const applyRedirect = (message: EmailMessageInput, inbox: string, label: string): EmailMessageInput => {
  const { cc: _cc, bcc: _bcc, ...rest } = message
  return { ...rest, to: inbox, subject: redirectSubject(message, label) }
}
