/**
 * AES-256-GCM helpers for Xero OAuth tokens. Web Crypto only, so they run on Workers.
 *
 * - The key is 32 random bytes, base64 encoded, supplied through env (`XERO_TOKEN_ENCRYPTION_KEY`).
 * - Every call uses a fresh random 96-bit IV.
 * - Output is `v1.<iv>.<ciphertext+tag>`, both base64url.
 * - `context` (for example the tenant ID) is bound in as additional authenticated data, so a
 *   token copied onto another tenant's row fails to decrypt.
 *
 * Errors never include the plaintext, ciphertext or key.
 */

export const XERO_TOKEN_KEY_ENV = 'XERO_TOKEN_ENCRYPTION_KEY'

const VERSION = 'v1'
const KEY_BYTES = 32
const IV_BYTES = 12

export class XeroCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'XeroCryptoError'
  }
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new XeroCryptoError('Invalid encrypted token')

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)

  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** Generate a new key to store in env. Run once per environment, never commit the result. */
export const generateEncryptionKey = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(KEY_BYTES))))

const importKey = async (base64Key: string | undefined): Promise<CryptoKey> => {
  if (!base64Key) throw new XeroCryptoError(`${XERO_TOKEN_KEY_ENV} is not set`)

  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = Uint8Array.from(atob(base64Key.trim()), (char) => char.charCodeAt(0))
  } catch {
    throw new XeroCryptoError(`${XERO_TOKEN_KEY_ENV} must be base64`)
  }

  if (raw.byteLength !== KEY_BYTES) {
    throw new XeroCryptoError(`${XERO_TOKEN_KEY_ENV} must decode to ${KEY_BYTES} bytes`)
  }

  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

const aad = (context: string | undefined): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(context ?? ''))

export const encryptToken = async (
  plaintext: string,
  base64Key: string | undefined,
  context?: string,
): Promise<string> => {
  const key = await importKey(base64Key)
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: aad(context), iv, name: 'AES-GCM' },
    key,
    new Uint8Array(new TextEncoder().encode(plaintext)),
  )

  return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`
}

export const decryptToken = async (
  payload: string,
  base64Key: string | undefined,
  context?: string,
): Promise<string> => {
  const key = await importKey(base64Key)
  const parts = payload.split('.')

  if (parts.length !== 3 || parts[0] !== VERSION) {
    throw new XeroCryptoError('Invalid encrypted token')
  }

  try {
    const iv = fromBase64Url(parts[1])
    const ciphertext = fromBase64Url(parts[2])
    if (iv.byteLength !== IV_BYTES) throw new XeroCryptoError('Invalid encrypted token')

    const plaintext = await crypto.subtle.decrypt(
      { additionalData: aad(context), iv, name: 'AES-GCM' },
      key,
      ciphertext,
    )

    return new TextDecoder().decode(plaintext)
  } catch {
    // Deliberately generic: wrong key, tampering and bad context are indistinguishable.
    throw new XeroCryptoError('Could not decrypt token')
  }
}
