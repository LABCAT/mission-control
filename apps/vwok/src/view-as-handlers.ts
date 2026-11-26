import {
  clearViewAsCookies,
  endViewAs,
  isSameOriginPost,
  readCookie,
  redeemViewAsCode,
  SESSION_COOKIE,
  VIEW_AS_LANDING_PATH,
  viewAsCookies,
  type ViewAsClient,
} from '@mission-control/launchpad/view-as'
import {
  clearHintCookie,
  clearSignInCookies,
  readSession,
  signInCookies,
} from '@mission-control/launchpad/sign-in'

import { siteTenant } from './brand'

/**
 * The three site-side pieces of "view as user" (PJ-119): start, exit and the name for the banner.
 * Plain Request to Response functions with the environment passed in, so they are tested without
 * a Worker. The Astro endpoints in `pages/` are one-line wrappers.
 */
export type ViewAsEnv = { CMS_URL?: string; SITE_KEY?: string }

const NO_STORE = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }

const clientFor = (env: ViewAsEnv): null | ViewAsClient =>
  env.CMS_URL && env.SITE_KEY && siteTenant.slug
    ? { cmsUrl: env.CMS_URL, siteKey: env.SITE_KEY, tenantSlug: siteTenant.slug }
    : null

const isSecure = (request: Request): boolean => new URL(request.url).protocol === 'https:'

const redirect = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers({ ...NO_STORE, location })
  for (const cookie of cookies) headers.append('set-cookie', cookie)

  return new Response(null, { headers, status: 303 })
}

const page = (status: number, message: string): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>${message}</title><p>${message}</p>`,
    { headers: { ...NO_STORE, 'content-type': 'text/html; charset=utf-8' }, status },
  )

/**
 * The CMS admin posts the one-time code here (a cross-site form post, which is why this does not
 * check the origin: the code itself is the secret, it works once for 60 seconds, and only this
 * site can swap it, with the site key). Sets the session and the banner hint, then lands on the account.
 */
export const handleViewAsStart = async (request: Request, env: ViewAsEnv): Promise<Response> => {
  const client = clientFor(env)
  if (!client) return page(503, 'View as user is not configured.')

  let code: unknown
  try {
    code = (await request.formData()).get('code')
  } catch {
    return page(400, 'This link is not valid.')
  }

  const result = await redeemViewAsCode(client, code)
  if (!result) return page(400, 'This link is invalid or has expired. Start again from the admin.')

  return redirect(
    VIEW_AS_LANDING_PATH,
    viewAsCookies({ expiresIn: result.expiresIn, secure: isSecure(request), token: result.token }),
  )
}

/**
 * Exit the view: end it on the CMS, clear both cookies, and go back to the admin. Same-origin
 * POSTs only, so no other site can end (or fake) it. The cookies are cleared even if the CMS is down.
 */
export const handleViewAsExit = async (request: Request, env: ViewAsEnv): Promise<Response> => {
  if (!isSameOriginPost(request)) return page(403, 'This request is not allowed.')

  const client = clientFor(env)
  if (client) await endViewAs(client, readCookie(request.headers.get('cookie'), SESSION_COOKIE))

  return redirect(
    `${(env.CMS_URL ?? '').replace(/\/$/, '')}/admin`,
    clearViewAsCookies({ secure: isSecure(request) }),
  )
}

/**
 * `/api/me`: the name, whether this is a view, and the self-correction for both hints. Never
 * cached. The email, role and ids stay on the server. A token the CMS no longer accepts clears the
 * `impersonating` and `signed_in` hints (and the dead session cookie), so a stale hint corrects
 * itself and the header goes back to "Sign in" (PJ-109). A "Keep me signed in" session the CMS
 * rolled arrives as a new token, which replaces the cookie and renews the hint.
 */
export const handleMe = async (request: Request, env: ViewAsEnv): Promise<Response> => {
  const client = clientFor(env)
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  const secure = isSecure(request)
  const unauthenticated = () => {
    const headers = new Headers(NO_STORE)
    headers.append('set-cookie', clearViewAsCookies({ secure })[1]!)
    headers.append('set-cookie', clearHintCookie({ secure }))
    // A cookie the CMS refused is dead weight. No cookie at all needs nothing cleared.
    if (token) headers.append('set-cookie', clearSignInCookies({ secure })[0]!)

    return Response.json({ error: 'not_authenticated' }, { headers, status: 401 })
  }

  if (!client || !token) return unauthenticated()

  const me = await readSession(client, token)
  if (me.status !== 200 || !me.user) return unauthenticated()

  const headers = new Headers(NO_STORE)
  if (me.renewed) {
    for (const cookie of signInCookies({ expiresIn: me.renewed.expiresIn, secure, token: me.renewed.token })) {
      headers.append('set-cookie', cookie)
    }
  }

  return Response.json({ user: me.user, viewAs: me.viewAs }, { headers })
}
