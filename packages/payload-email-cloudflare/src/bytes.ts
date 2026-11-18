import type { EmailAttachmentInput } from './types'
import { EmailSendError } from './errors'

export const toBytes = (attachment: EmailAttachmentInput): Uint8Array => {
  const { content } = attachment
  if (content === undefined) {
    throw new EmailSendError('adapter', 'attachment has no content (path/href attachments are not supported)')
  }
  if (typeof content === 'string') {
    if (attachment.encoding === 'base64') {
      const binary = atob(content)
      return Uint8Array.from(binary, (char) => char.charCodeAt(0))
    }
    return new TextEncoder().encode(content)
  }
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}
