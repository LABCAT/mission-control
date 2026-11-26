import { readCookie, SESSION_COOKIE, type ViewAsClient } from '../view-as'

/**
 * Email sign-in on the site (PJ-109). The CMS owns the codes, the sessions and their length; the
 * site only moves the visitor through the form and keeps two cookies, both set here:
 *
 * - `mc_session`: the token, HttpOnly (the cookie contract in docs/ACCOUNT-AUTH.md).
 * - `signed_in=1`: a hint, NOT HttpOnly, no personal data, the same expiry as the session. A tiny
 *   inline script swaps "Sign in" for "My account" from it, so a cached page never changes.
 *   `/api/me` (never cached) corrects a stale hint.
 */

export { readCookie, SESSION_COOKIE }

export const SIGNED_IN_HINT_COOKIE = 'signed_in'
/** HttpOnly, 15 minutes: remembers the address between "send me a code" and "enter the code". */
export const SIGN_IN_EMAIL_COOKIE = 'mc_sign_in_email'

export const SIGN_IN_PATH = '/account/sign-in'
export const SIGN_IN_CODE_PATH = '/account/sign-in/code'
export const SIGN_IN_VERIFY_PATH = '/account/sign-in/verify'
export const SIGN_OUT_PATH = '/account/sign-out'
export const ACCOUNT_PATH = '/account'

/** A same-site path only, so the form cannot be turned into an open redirect. */
export const safeReturnPath = (value: unknown): null | string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null

  return value
}

/** The sign-in page, with the page to come back to. Used by /account when the session is invalid. */
export const signInUrl = (returnTo?: unknown): string => {
  const safe = safeReturnPath(returnTo)

  return safe && !safe.startsWith(SIGN_IN_PATH) ? `${SIGN_IN_PATH}?returnTo=${encodeURIComponent(safe)}` : SIGN_IN_PATH
}

type CookieOptions = { secure: boolean }

const attributes = ({ secure }: CookieOptions): string => `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`

/** `Set-Cookie` values that start a session: the HttpOnly token and the hint, with one expiry. */
export const signInCookies = ({
  expiresIn,
  secure,
  token,
}: CookieOptions & { expiresIn: number; token: string }): string[] => {
  const maxAge = Math.max(0, Math.floor(expiresIn))

  return [
    `${SESSION_COOKIE}=${token}; HttpOnly; Max-Age=${maxAge}; ${attributes({ secure })}`,
    `${SIGNED_IN_HINT_COOKIE}=1; Max-Age=${maxAge}; ${attributes({ secure })}`,
  ]
}

export const clearHintCookie = ({ secure }: CookieOptions): string =>
  `${SIGNED_IN_HINT_COOKIE}=; Max-Age=0; ${attributes({ secure })}`

/** `Set-Cookie` values that end it: both cookies, so a signed-out page never says "My account". */
export const clearSignInCookies = ({ secure }: CookieOptions): string[] => [
  `${SESSION_COOKIE}=; HttpOnly; Max-Age=0; ${attributes({ secure })}`,
  clearHintCookie({ secure }),
]

export const signInEmailCookie = ({ email, secure }: CookieOptions & { email: string }): string =>
  `${SIGN_IN_EMAIL_COOKIE}=${encodeURIComponent(email)}; HttpOnly; Max-Age=900; Path=${SIGN_IN_PATH}; SameSite=Lax${secure ? '; Secure' : ''}`

export const clearSignInEmailCookie = ({ secure }: CookieOptions): string =>
  `${SIGN_IN_EMAIL_COOKIE}=; HttpOnly; Max-Age=0; Path=${SIGN_IN_PATH}; SameSite=Lax${secure ? '; Secure' : ''}`

export type SignInClient = ViewAsClient

type CmsResult = { body: null | Record<string, any>; status: number }

const call = async (
  client: SignInClient,
  method: 'GET' | 'POST',
  action: string,
  { body, ip, token }: { body?: unknown; ip?: null | string; token?: string } = {},
): Promise<CmsResult> => {
  const response = await (client.fetch ?? fetch)(
    `${client.cmsUrl.replace(/\/$/, '')}/api/tenants/${encodeURIComponent(client.tenantSlug)}/account/${action}`,
    {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'x-site-key': client.siteKey,
        ...(ip ? { 'x-end-user-ip': ip } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method,
    },
  )

  return { body: (await response.json().catch(() => null)) as CmsResult['body'], status: response.status }
}

export type RequestCodeResult =
  | { ok: true }
  | { error: 'invalid_request' | 'rate_limited' | 'turnstile_failed' | 'unavailable' }

/** "Send me a code". The CMS answers the same whether or not the address has an account. */
export const requestSignInCode = async (
  client: SignInClient,
  input: { email: string; ip?: null | string; keepSignedIn: boolean; returnTo?: null | string; turnstileToken: string },
): Promise<RequestCodeResult> => {
  const { body, status } = await call(client, 'POST', 'sign-in/request', {
    body: {
      email: input.email,
      keepSignedIn: input.keepSignedIn,
      returnTo: safeReturnPath(input.returnTo) ?? undefined,
      turnstileToken: input.turnstileToken,
    },
    ip: input.ip,
  })

  if (status === 202) return { ok: true }
  if (status === 429) return { error: 'rate_limited' }
  if (body?.error?.code === 'turnstile_failed') return { error: 'turnstile_failed' }
  if (status === 400) return { error: 'invalid_request' }

  return { error: 'unavailable' }
}

export type VerifyResult =
  | { expiresIn: number; ok: true; returnTo: null | string; token: string }
  | { error: 'invalid_code' | 'rate_limited' | 'unavailable' }

/** Finish sign-in with the 6-digit code (and the address) or the token from the link. */
export const verifySignIn = async (
  client: SignInClient,
  input: { code?: string; email?: string; ip?: null | string; token?: string },
): Promise<VerifyResult> => {
  const { body, status } = await call(client, 'POST', 'sign-in/verify', {
    body: input.token ? { token: input.token } : { code: input.code, email: input.email },
    ip: input.ip,
  })

  if (status === 200 && typeof body?.token === 'string' && typeof body.expiresIn === 'number') {
    return { expiresIn: body.expiresIn, ok: true, returnTo: safeReturnPath(body.returnTo), token: body.token }
  }

  if (status === 429) return { error: 'rate_limited' }
  if (status === 400) return { error: 'invalid_code' }

  return { error: 'unavailable' }
}

/** Ends the session on the CMS. Best effort: the cookies are cleared whatever this answers. */
export const signOutOnCms = async (client: SignInClient, token: null | string): Promise<void> => {
  if (!token) return

  await call(client, 'POST', 'logout', { token }).catch(() => {})
}

/**
 * The inline script that swaps "Sign in" for "My account". It runs on every page and does
 * nothing without the hint cookie. With the hint it rewrites the link at once (no request, so
 * nothing shifts), then asks `/api/me`: a 401 means the hint was stale, so it removes the hint
 * and puts the link back. A link can name its own label with `data-signed-in-label`.
 */
export const SIGNED_IN_SCRIPT = `(function(){
if(!/(?:^|;\\s*)signed_in=1(?:;|$)/.test(document.cookie))return;
var links=[].slice.call(document.querySelectorAll('a[href^="/account/sign-in"]'));
links.forEach(function(a){a.setAttribute('data-mc-href',a.getAttribute('href'));a.setAttribute('data-mc-text',a.textContent);a.setAttribute('href','/account');a.textContent=a.getAttribute('data-signed-in-label')||'My account'});
fetch('/api/me',{credentials:'same-origin',headers:{accept:'application/json'}}).then(function(r){
if(r.status!==401)return;
document.cookie='signed_in=; Max-Age=0; Path=/';
links.forEach(function(a){a.setAttribute('href',a.getAttribute('data-mc-href'));a.textContent=a.getAttribute('data-mc-text')})
}).catch(function(){})
})();`

export type MeSession = {
  renewed: null | { expiresIn: number; token: string }
  status: number
  user: null | { firstName: null | string; lastName: null | string }
  viewAs: boolean
}

/**
 * Who is signed in, for `/api/me`. When the CMS rolled a "Keep me signed in" session it sends the
 * new token back, and the site must replace its cookies with it (`renewed`).
 */
export const readSession = async (client: SignInClient, token: string): Promise<MeSession> => {
  const { body, status } = await call(client, 'GET', 'me', { token })
  const user = body?.user as undefined | { firstName?: null | string; lastName?: null | string }
  const session = body?.session as undefined | { expiresIn?: number; token?: string }

  return {
    renewed:
      status === 200 && typeof session?.token === 'string' && typeof session.expiresIn === 'number'
        ? { expiresIn: session.expiresIn, token: session.token }
        : null,
    status,
    user: status === 200 && user ? { firstName: user.firstName ?? null, lastName: user.lastName ?? null } : null,
    viewAs: status === 200 && Boolean(body?.viewAs),
  }
}
