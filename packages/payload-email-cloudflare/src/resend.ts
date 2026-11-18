import { toBase64, toBytes } from './bytes'
import { toDisplayAddress } from './address'
import { EmailSendError, redact } from './errors'
import type { EmailMessageInput, Recipients } from './types'

const list = (value: Recipients | undefined): string[] | undefined =>
  value === undefined ? undefined : (Array.isArray(value) ? value : [value]).map(toDisplayAddress)

/** Build the JSON body for Resend's `POST /emails`. */
export const mapToResendPayload = (message: EmailMessageInput): Record<string, unknown> => ({
  from: toDisplayAddress(message.from ?? ''),
  to: list(message.to) ?? [],
  subject: message.subject ?? '',
  ...(message.cc !== undefined ? { cc: list(message.cc) } : {}),
  ...(message.bcc !== undefined ? { bcc: list(message.bcc) } : {}),
  ...(message.replyTo !== undefined ? { reply_to: toDisplayAddress(message.replyTo) } : {}),
  ...(typeof message.html === 'string' ? { html: message.html } : {}),
  ...(typeof message.text === 'string' ? { text: message.text } : {}),
  ...(message.headers ? { headers: message.headers } : {}),
  ...(message.attachments?.length
    ? {
        attachments: message.attachments.map((attachment) => {
          if (attachment.path !== undefined || attachment.href !== undefined) {
            throw new EmailSendError('adapter', 'attachments must carry inline `content`; `path`/`href` are not supported')
          }
          return {
            filename: attachment.filename ?? 'attachment',
            content: toBase64(toBytes(attachment)),
            ...(attachment.contentType ? { content_type: attachment.contentType } : {}),
            ...(attachment.cid ? { content_id: attachment.cid } : {}),
          }
        }),
      }
    : {}),
})

export const sendViaResend = async (
  message: EmailMessageInput,
  apiKey: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<void> => {
  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(mapToResendPayload(message)),
    })
  } catch (error) {
    // Network failures: keep the cause's message only after scrubbing the key.
    const reason = error instanceof Error ? error.message : 'request failed'
    throw new EmailSendError('resend', `request failed (${redact(reason, [apiKey])})`)
  }
  if (response.ok) return
  let detail = ''
  try {
    const body = (await response.json()) as { message?: unknown }
    if (typeof body.message === 'string') detail = redact(body.message, [apiKey]).slice(0, 200)
  } catch {
    // Non-JSON error body: status alone is enough.
  }
  throw new EmailSendError('resend', `HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status)
}
