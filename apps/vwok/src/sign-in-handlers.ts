import {
  ACCOUNT_PATH,
  clearSignInCookies,
  clearSignInEmailCookie,
  requestSignInCode,
  safeReturnPath,
  SIGN_IN_CODE_PATH,
  SIGN_IN_EMAIL_COOKIE,
  SIGN_IN_PATH,
  signInCookies,
  signInEmailCookie,
  signOutOnCms,
  verifySignIn,
  type SignInClient,
} from '@mission-control/launchpad/sign-in'
import {
  clearViewAsCookies,
  isSameOriginPost,
  readCookie,
  SESSION_COOKIE,
  VIEW_AS_HINT_COOKIE,
} from '@mission-control/launchpad/view-as'

import { siteTenant } from './brand'

/**
 * The form posts behind the sign-in pages (PJ-109): ask for a code, finish with the code or the
 * link, and sign out. Plain Request to Response functions, so they run without a Worker and the
 * pages work with JavaScript off. The Astro endpoints in `pages/` are one-line wrappers.
 *
 * Every answer is a 303 back to a page: an error is a query value (`?error=code`), never the
 * address, the code or the token, so nothing personal lands in a URL or a log.
 */
export type SignInEnv = { CMS_URL?: string; SITE_KEY?: string }

const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }

const clientFor = (env: SignInEnv): null | SignInClient =>
  env.CMS_URL && env.SITE_KEY && siteTenant.slug
    ? { cmsUrl: env.CMS_URL, siteKey: env.SITE_KEY, tenantSlug: siteTenant.slug }
    : null

const isSecure = (request: Request): boolean => new URL(request.url).protocol === 'https:'

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({ ...NO_STORE, location })
  for (const cookie of cookies) headers.append('set-cookie', cookie)

  return new Response(null, { headers, status: 303 })
}

const refused = (status: number, message: string): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${message}</title><p>${message}</p>`,
    { headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' }, status },
  )

const withQuery = (path: string, values: Record<string, null | string | undefined>): string => {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value)
  const text = query.toString()

  return text ? `${path}?${text}` : path
}

const field = (form: FormData, name: string, max = 500): string => {
  const value = form.get(name)

  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

const visitorIP = (request: Request): null | string => request.headers.get('cf-connecting-ip')?.trim() || null

const readForm = async (request: Request): Promise<FormData | null> => {
  try {
    return await request.formData()
  } catch {
    return null
  }
}

/** "Send me a code": the form on /account/sign-in. */
export const handleSignInRequest = async (request: Request, env: SignInEnv): Promise<Response> => {
  if (!isSameOriginPost(request)) return refused(403, 'This request is not allowed.')

  const client = clientFor(env)
  if (!client) return refused(503, 'Sign-in is not configured.')

  const form = await readForm(request)
  if (!form) return refused(400, 'This request is not valid.')

  const returnTo = safeReturnPath(field(form, 'returnTo'))
  const email = field(form, 'email', 254).toLowerCase()
  const keepSignedIn = form.get('keepSignedIn') === 'on'
  const back = (error: string) => redirect(withQuery(SIGN_IN_PATH, { error, returnTo }))

  const result = await requestSignInCode(client, {
    email,
    ip: visitorIP(request),
    keepSignedIn,
    returnTo,
    turnstileToken: field(form, 'cf-turnstile-response', 2048),
  })

  if ('error' in result) return back(result.error)

  // The same page whether or not the address has an account. The address rides in an HttpOnly
  // cookie for 15 minutes so the next page can prefill it, and it never appears in a URL.
  return redirect(withQuery(SIGN_IN_CODE_PATH, { returnTo }), [
    signInEmailCookie({ email, secure: isSecure(request) }),
  ])
}

/** Finish sign-in: the 6-digit code, or the one-button page the link opens. */
export const handleSignInSubmit = async (request: Request, env: SignInEnv): Promise<Response> => {
  if (!isSameOriginPost(request)) return refused(403, 'This request is not allowed.')

  const client = clientFor(env)
  if (!client) return refused(503, 'Sign-in is not configured.')

  const form = await readForm(request)
  if (!form) return refused(400, 'This request is not valid.')

  const token = field(form, 'token', 200)
  const formReturnTo = safeReturnPath(field(form, 'returnTo'))
  const email = (field(form, 'email', 254) || readCookie(request.headers.get('cookie'), SIGN_IN_EMAIL_COOKIE) || '')
    .toLowerCase()

  const result = await verifySignIn(client, {
    ip: visitorIP(request),
    ...(token
      ? { token }
      : { code: field(form, 'code', 12).replace(/\s+/g, ''), email: safeDecode(email) }),
  })

  if ('error' in result) {
    // A link that did not work goes back to the start, a wrong code stays on the code page.
    return redirect(
      token
        ? withQuery(SIGN_IN_PATH, { error: result.error === 'rate_limited' ? 'rate_limited' : 'link', returnTo: formReturnTo })
        : withQuery(SIGN_IN_CODE_PATH, { error: result.error, returnTo: formReturnTo }),
    )
  }

  const secure = isSecure(request)

  return redirect(result.returnTo ?? formReturnTo ?? ACCOUNT_PATH, [
    ...signInCookies({ expiresIn: result.expiresIn, secure, token: result.token }),
    clearSignInEmailCookie({ secure }),
    // A new session replaces any view-as one, so its banner hint goes too.
    viewAsHintCleared(secure),
  ])
}

/** The cookie that clears the view-as banner hint, found by name rather than by position. */
const viewAsHintCleared = (secure: boolean): string =>
  clearViewAsCookies({ secure }).find((cookie) => cookie.startsWith(`${VIEW_AS_HINT_COOKIE}=`)) ?? ''

const safeDecode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Sign out: end the session on the CMS, clear both cookies, go home. Same-origin POST only. */
export const handleSignOut = async (request: Request, env: SignInEnv): Promise<Response> => {
  if (!isSameOriginPost(request)) return refused(403, 'This request is not allowed.')

  const client = clientFor(env)
  if (client) await signOutOnCms(client, readCookie(request.headers.get('cookie'), SESSION_COOKIE))

  const secure = isSecure(request)

  return redirect('/', [
    ...clearSignInCookies({ secure }),
    clearSignInEmailCookie({ secure }),
    // Signing out also ends a view-as banner left behind.
    viewAsHintCleared(secure),
  ])
}
