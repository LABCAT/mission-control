import type { CollectionSlug, Endpoint, Payload } from 'payload'

import {
  AccountAuthError,
  accountResponse,
  canSignInOn,
  endpoint,
  enforceRateLimit,
  ERRORS,
  findUserByEmail,
  normaliseEmail,
  publicUser,
  readBody,
  resolveOptions,
  tenantSiteURL,
  type AccountAuthOptions,
  type AccountTenant,
  type Handler,
  type RawUser,
  type ResolvedOptions,
} from './account-auth'
import { issueSession, sessionSeconds } from './account-sessions'
import { createTenantEmailSender } from './email'
import {
  TURNSTILE_TOKEN_FIELD,
  verifyTurnstileWithCloudflare,
} from './forms'
import { assertNotViewingAs } from './view-as'

/**
 * Email sign-in (PJ-109): one email carries a magic link and a 6-digit code. The link finishes
 * the sign-in on the same device, the code on another one. Passwords stay an option beside it.
 *
 * - The code is 6 digits, lasts 15 minutes and works once. Five wrong guesses spend it.
 * - Asking again within 30 seconds sends nothing new, and the answer is the same either way, so
 *   the endpoint never says whether an address has an account.
 * - Only the hashes of the code and the link token are stored (`payload.kv`, no table), keyed by
 *   tenant and address, so the same address on two tenants has two separate codes.
 * - Using either the code or the link spends both.
 *
 * Event raised for the email templates (PJ-50/PJ-51): `account.sign_in_code`, with the variables in
 * `SignInEmailDoc`.
 */

export const SIGN_IN_EVENT = 'account.sign_in_code'
export const SIGN_IN_CODE_TTL_SECONDS = 15 * 60
export const SIGN_IN_RESEND_SECONDS = 30
export const SIGN_IN_MAX_ATTEMPTS = 5

/** The variables the sign-in code email can use. */
export type SignInEmailDoc = {
  /** The 6-digit code, for another device. */
  code: string
  /** Minutes the code and link stay valid. */
  expiresInMinutes: number
  /** The magic link, for this device. Opens a page with one button, so a mail scanner cannot spend it. */
  link: string
  siteUrl: string
  tenant: { id: number | string; name: string; slug: string }
  to: string
}

/** Same shape as `sendTemplate(event, doc)` from the email core (PJ-50). */
export type SignInEmailSender = (event: typeof SIGN_IN_EVENT, doc: SignInEmailDoc) => Promise<unknown>

type CodeRecord = {
  attempts: number
  codeHash: string
  email: string
  expiresAt: number
  issuedAt: number
  keepSignedIn: boolean
  returnTo: null | string
  tokenHash: string
}

const RECORD_PREFIX = 'mc:sign-in:'
const TOKEN_PREFIX = 'mc:sign-in-token:'

const encoder = new TextEncoder()

const sha256Hex = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const sameText = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false

  let difference = 0
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }

  return difference === 0
}

/** Six digits, uniformly (rejection sampling, so there is no modulo bias). */
export const generateSignInCode = (): string => {
  const limit = 4_294_000_000 // the largest multiple of 1,000,000 below 2^32

  for (;;) {
    const [value] = crypto.getRandomValues(new Uint32Array(1)) as Uint32Array
    if (value! < limit) return String(value! % 1_000_000).padStart(6, '0')
  }
}

const generateToken = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const recordKey = async (tenantID: number | string, email: string): Promise<string> =>
  `${RECORD_PREFIX}${await sha256Hex(`${tenantID}:${email}`)}`

const codeHashOf = (tenantID: number | string, email: string, code: string): Promise<string> =>
  sha256Hex(`code:${tenantID}:${email}:${code}`)

/** A same-site path only: nothing that can send the visitor to another site after sign-in. */
export const safeReturnPath = (value: unknown): null | string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null

  return value
}

const escapeHTML = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Plain email used until the tenant's templates (PJ-50) are wired in. */
const inlineSignInEmail = (payload: Payload, tenant: AccountTenant): SignInEmailSender => {
  const send = createTenantEmailSender(payload)

  return (_event, doc) =>
    send({
      html:
        `<p>Your ${escapeHTML(doc.tenant.name)} sign-in code is <strong>${escapeHTML(doc.code)}</strong>.</p>` +
        `<p>Or <a href="${escapeHTML(doc.link)}">sign in with this link</a> on this device.</p>` +
        `<p>The code and the link work once and expire in ${doc.expiresInMinutes} minutes. ` +
        'If you did not ask for this, you can ignore this email.</p>',
      subject: `Your ${doc.tenant.name} sign-in code: ${doc.code}`,
      tenant,
      to: doc.to,
    })
}

const checkTurnstile = async (
  options: ResolvedOptions,
  body: Record<string, unknown>,
  remoteIp: null | string,
): Promise<void> => {
  const config = options.turnstile
  if (config?.enabled === false) return

  const secret = config?.secret?.()
  const token = body[TURNSTILE_TOKEN_FIELD] ?? body.turnstileToken

  // No secret fails closed, as for the public forms: an unchecked sign-in is worse than an
  // unavailable one.
  if (!secret || typeof token !== 'string' || !token || token.length > 2048) {
    throw new AccountAuthError({
      code: 'turnstile_failed',
      message: 'Complete the verification and try again.',
      status: 400,
    })
  }

  const result = await (config?.verify ?? verifyTurnstileWithCloudflare)({
    remoteIp: remoteIp && remoteIp !== 'unknown' ? remoteIp : null,
    secret,
    token,
  })

  if (!result.success) {
    throw new AccountAuthError({
      code: 'turnstile_failed',
      message: 'Complete the verification and try again.',
      status: 400,
    })
  }
}

const requestIP = (headers: Headers): null | string =>
  headers.get('x-end-user-ip')?.trim() || headers.get('cf-connecting-ip')?.trim() || null

const invalidCode = new AccountAuthError({
  code: 'invalid_code',
  message: 'This code or link is invalid or has expired. Ask for a new one.',
  status: 400,
})

const requestCode: Handler = async ({ options, req, tenant }) => {
  await assertNotViewingAs(req, 'account.sign-in-request')

  const body = await readBody(req)
  const email = normaliseEmail(body.email)
  if (!email) throw new AccountAuthError(ERRORS.invalidBody)

  await checkTurnstile(options, body, requestIP(req.headers))
  await enforceRateLimit({ action: 'sign-in-request', identifier: email, options, req, tenant })

  // Same answer whatever happens below.
  const answer = () =>
    accountResponse(
      {
        expiresInMinutes: SIGN_IN_CODE_TTL_SECONDS / 60,
        ok: true,
        resendAfterSeconds: SIGN_IN_RESEND_SECONDS,
      },
      202,
    )

  const base = tenantSiteURL(tenant)
  if (!base) {
    req.payload.logger.error(`account-auth: tenant ${tenant.slug} has no domain for sign-in links`)

    return answer()
  }

  const user = await findUserByEmail(req.payload, options, email)
  if (!user || !canSignInOn(user, tenant.id, options)) return answer()

  const key = await recordKey(tenant.id, email)
  const existing = await req.payload.kv.get<CodeRecord>(key)
  const now = Date.now()

  // Asking again too soon sends nothing new: the first email is still on its way.
  if (existing && now - existing.issuedAt < SIGN_IN_RESEND_SECONDS * 1000) return answer()

  // A new request replaces the old code and link.
  if (existing) await req.payload.kv.delete(`${TOKEN_PREFIX}${existing.tokenHash}`)

  const code = generateSignInCode()
  const token = generateToken()
  const tokenHash = await sha256Hex(`token:${token}`)
  const returnTo = safeReturnPath(body.returnTo)

  await req.payload.kv.set(key, {
    attempts: 0,
    codeHash: await codeHashOf(tenant.id, email, code),
    email,
    expiresAt: now + SIGN_IN_CODE_TTL_SECONDS * 1000,
    issuedAt: now,
    keepSignedIn: body.keepSignedIn === true,
    returnTo,
    tokenHash,
  } satisfies CodeRecord)
  await req.payload.kv.set(`${TOKEN_PREFIX}${tokenHash}`, { key })

  const query = new URLSearchParams({ token })
  if (returnTo) query.set('returnTo', returnTo)

  const doc: SignInEmailDoc = {
    code,
    expiresInMinutes: SIGN_IN_CODE_TTL_SECONDS / 60,
    link: `${base}${options.signInPath}?${query.toString()}`,
    siteUrl: base,
    tenant: { id: tenant.id, name: tenant.name ?? tenant.slug, slug: tenant.slug },
    to: email,
  }

  try {
    await (options.sendEmail ?? inlineSignInEmail(req.payload, tenant))(SIGN_IN_EVENT, doc)
  } catch (error) {
    // Answer the same way, so an address cannot be probed. The failure is logged.
    req.payload.logger.error({ err: error, msg: 'account-auth: could not send the sign-in email' })
  }

  return answer()
}

const spend = async (payload: Payload, key: string, record: CodeRecord): Promise<void> => {
  await payload.kv.delete(key)
  await payload.kv.delete(`${TOKEN_PREFIX}${record.tokenHash}`)
}

const verifyCode: Handler = async ({ options, req, tenant }) => {
  await assertNotViewingAs(req, 'account.sign-in-verify')

  const body = await readBody(req)
  const token = typeof body.token === 'string' && body.token.length <= 200 ? body.token : null
  const email = normaliseEmail(body.email)
  const code = typeof body.code === 'string' ? body.code.trim() : ''

  // The link carries a token; the code needs the address it was sent to.
  if (!token && (!email || !/^\d{6}$/.test(code))) throw invalidCode

  await enforceRateLimit({ action: 'sign-in-verify', identifier: email, options, req, tenant })

  let key: null | string
  if (token) {
    const index = await req.payload.kv.get<{ key?: string }>(
      `${TOKEN_PREFIX}${await sha256Hex(`token:${token}`)}`,
    )
    key = typeof index?.key === 'string' ? index.key : null
  } else {
    key = await recordKey(tenant.id, email!)
  }

  const record = key ? await req.payload.kv.get<CodeRecord>(key) : null
  if (!key || !record) throw invalidCode

  // A link token from another tenant is refused without being spent.
  if (key !== (await recordKey(tenant.id, record.email))) throw invalidCode

  if (record.expiresAt <= Date.now()) {
    await spend(req.payload, key, record)
    throw invalidCode
  }

  // A link token is unguessable. A 6-digit code is not, so it gets a few tries and is then spent.
  if (!token) {
    const matches = sameText(record.codeHash, await codeHashOf(tenant.id, email!, code))

    if (!matches) {
      if (record.attempts + 1 >= SIGN_IN_MAX_ATTEMPTS) {
        await spend(req.payload, key, record)
      } else {
        await req.payload.kv.set(key, { ...record, attempts: record.attempts + 1 })
      }

      throw invalidCode
    }
  }

  // Spent before anything else happens, so a second request with the same code finds nothing.
  await spend(req.payload, key, record)

  const user = await findUserByEmail(req.payload, options, record.email)
  if (!user || !canSignInOn(user, tenant.id, options)) throw invalidCode

  // Receiving the code proves the address, so it also confirms an account that was never verified.
  if ((user as { _verified?: boolean })._verified === false) {
    await req.payload.db.updateOne({
      id: user.id,
      collection: options.usersSlug as CollectionSlug,
      data: { _verificationToken: null, _verified: true, updatedAt: null },
      returning: false,
    })
  }

  const session = await issueSession({
    keepSignedIn: record.keepSignedIn,
    payload: req.payload,
    seconds: sessionSeconds(tenant as never, record.keepSignedIn),
    userID: user.id,
    usersSlug: options.usersSlug,
  })

  return accountResponse({
    exp: session.exp,
    expiresIn: session.expiresIn,
    keepSignedIn: session.keepSignedIn,
    returnTo: record.returnTo,
    token: session.token,
    user: publicUser(user as RawUser, tenant.id),
  })
}

/** The sign-in endpoints, to add to the tenants collection's `endpoints` beside the account ones. */
export const signInEndpoints = (incoming: AccountAuthOptions = {}): Endpoint[] => {
  const options = resolveOptions(incoming)

  return [
    endpoint(options, 'post', 'sign-in/request', requestCode),
    endpoint(options, 'post', 'sign-in/verify', verifyCode),
  ]
}
