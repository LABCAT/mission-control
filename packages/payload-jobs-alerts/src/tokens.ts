/**
 * Signed alert tokens (PJ-47). Every link in an alert email carries one: confirm, manage and
 * unsubscribe. They are stateless HMAC-SHA256 tokens, so nothing secret is stored, a link cannot
 * be guessed, and the tenant and purpose are part of what is signed:
 *
 * - a confirm link cannot unsubscribe, and a link from one site is worthless on another;
 * - confirm and manage links expire; an unsubscribe link never does, because a List-Unsubscribe
 *   header must keep working for as long as the email sits in an inbox.
 *
 * Format: `base64url(json).base64url(hmac)`. The key is the CMS secret, so there is no new
 * secret to provision; the purpose inside the signed payload keeps the uses apart.
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

const hmacKey = (secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, [
    usage,
  ])

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
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(body))

  return `${body}.${toBase64Url(new Uint8Array(signature))}`
}

export type VerifyAlertTokenArgs = {
  now?: Date
  purpose: AlertTokenPurpose
  secret: string
  tenant: number | string
  token: string
}

/** The subject the token was signed for, or `null` for anything that is not a valid, live token. */
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

  const [body, signature] = parts as [string, string]
  const signatureBytes = fromBase64Url(signature)
  const bodyBytes = fromBase64Url(body)
  if (!signatureBytes || !bodyBytes) return null

  // `verify` compares in constant time.
  const genuine = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret, 'verify'),
    signatureBytes as BufferSource,
    encoder.encode(body),
  )
  if (!genuine) return null

  let payload: Partial<Payload>

  try {
    payload = JSON.parse(decoder.decode(bodyBytes)) as Partial<Payload>
  } catch {
    return null
  }

  if (payload.p !== purpose || payload.t !== String(tenant)) return null
  if (typeof payload.s !== 'string' || typeof payload.e !== 'number') return null
  if (payload.e !== 0 && now.getTime() >= payload.e) return null

  return { subject: payload.s }
}
