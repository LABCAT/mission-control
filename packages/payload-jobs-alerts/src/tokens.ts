/**
 * Sealed alert tokens (PJ-47). Every link in an alert email carries one: confirm, manage and
 * unsubscribe. A token is AES-256-GCM over a small JSON payload, so it is both signed and
 * unreadable, and nothing secret is stored:
 *
 * - the subscriber's address (in a manage link) is not visible in the URL, which ends up in
 *   browser history, forwarded mail and request logs;
 * - the purpose and tenant are inside what is sealed, so a confirm link cannot unsubscribe and a
 *   link from one site is worthless on another;
 * - confirm and manage links expire; an unsubscribe link never does, because a List-Unsubscribe
 *   header must keep working for as long as the email sits in an inbox.
 *
 * Format: `base64url(iv).base64url(ciphertext+tag)`. The key is derived from the CMS secret with
 * a label of its own, so no other use of that secret shares it and the label can be bumped to
 * rotate every link.
 */

export type AlertTokenPurpose = 'confirm' | 'manage' | 'unsubscribe'

const DAY_MS = 24 * 60 * 60 * 1000

/** How long each kind of link works. `null` means it never expires. */
export const ALERT_TOKEN_TTL_MS: Record<AlertTokenPurpose, null | number> = {
  confirm: 7 * DAY_MS,
  manage: 30 * DAY_MS,
  unsubscribe: null,
}

type Payload = {
  /** Expiry as epoch milliseconds, or 0 for never. */
  e: number
  p: AlertTokenPurpose
  /** What the link is about: an alert id, or an email address for a manage link. */
  s: string
  t: string
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Bump the version to invalidate every outstanding link. */
const KEY_LABEL = 'mission-control/payload-jobs-alerts/v1'
const IV_BYTES = 12

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''

  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null

  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(padded)

    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

/** HMAC(secret, label) is the key: a sub-key, so the raw secret is never used directly. */
const sealingKey = async (secret: string, usage: 'decrypt' | 'encrypt'): Promise<CryptoKey> => {
  const hmac = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign'],
  )
  const raw = await crypto.subtle.sign('HMAC', hmac, encoder.encode(KEY_LABEL))

  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage])
}

export type SignAlertTokenArgs = {
  now?: Date
  purpose: AlertTokenPurpose
  secret: string
  subject: string
  tenant: number | string
}

export const signAlertToken = async ({
  now = new Date(),
  purpose,
  secret,
  subject,
  tenant,
}: SignAlertTokenArgs): Promise<string> => {
  if (!secret) throw new Error('payload-jobs-alerts: a secret is needed to sign alert tokens')

  const ttl = ALERT_TOKEN_TTL_MS[purpose]
  const payload: Payload = {
    e: ttl === null ? 0 : now.getTime() + ttl,
    p: purpose,
    s: subject,
    t: String(tenant),
  }
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const sealed = await crypto.subtle.encrypt(
    { iv, name: 'AES-GCM' },
    await sealingKey(secret, 'encrypt'),
    encoder.encode(JSON.stringify(payload)),
  )

  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(sealed))}`
}

export type VerifyAlertTokenArgs = {
  now?: Date
  purpose: AlertTokenPurpose
  secret: string
  tenant: number | string
  token: string
}

/** The subject the token was sealed for, or `null` for anything that is not a valid, live token. */
export const verifyAlertToken = async ({
  now = new Date(),
  purpose,
  secret,
  tenant,
  token,
}: VerifyAlertTokenArgs): Promise<null | { subject: string }> => {
  if (!secret || typeof token !== 'string') return null

  const parts = token.split('.')
  if (parts.length !== 2) return null

  const iv = fromBase64Url(parts[0]!)
  const sealed = fromBase64Url(parts[1]!)
  if (!iv || iv.length !== IV_BYTES || !sealed) return null

  let payload: Partial<Payload>

  try {
    // GCM authenticates: any changed byte, or another secret, fails here.
    const opened = await crypto.subtle.decrypt(
      { iv: iv as BufferSource, name: 'AES-GCM' },
      await sealingKey(secret, 'decrypt'),
      sealed as BufferSource,
    )
    payload = JSON.parse(decoder.decode(opened)) as Partial<Payload>
  } catch {
    return null
  }

  if (payload.p !== purpose || payload.t !== String(tenant)) return null
  if (typeof payload.s !== 'string' || typeof payload.e !== 'number') return null
  if (payload.e !== 0 && now.getTime() >= payload.e) return null

  return { subject: payload.s }
}
