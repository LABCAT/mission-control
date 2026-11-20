/**
 * RFC 2047 Q-encode a header value when it contains non-ASCII characters.
 *
 * worker-mailer encodes the same way, but its encoder lives in a module that imports
 * `cloudflare:sockets`, so doing it here keeps the mapping pure and testable outside Workers.
 * An already-encoded value is plain ASCII and passes through unchanged.
 */
export const encodeHeader = (text: string): string => {
  if (![...text].some((char) => char.charCodeAt(0) > 0x7f)) return text
  const bytes = new TextEncoder().encode(text)
  let encoded = ''
  for (const byte of bytes) {
    if (byte >= 33 && byte <= 126 && byte !== 63 && byte !== 61 && byte !== 95) {
      encoded += String.fromCharCode(byte)
    } else if (byte === 32) {
      encoded += '_'
    } else {
      encoded += `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return `=?UTF-8?Q?${encoded}?=`
}
