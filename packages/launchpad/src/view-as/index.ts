/**
 * "View as user" on the site (PJ-119, S-073, S-160). A super admin starts it from the CMS admin;
 * the CMS hands the admin page a one-time code, the admin page posts it to the site's
 * `/account/view-as/start`, and the site swaps it (server to server, with its site key) for a
 * 30-minute token. See packages/payload-jobs/src/view-as.ts for the CMS side.
 *
 * The site keeps two cookies, both set here and nowhere else:
 *
 * - `mc_session`: the token. HttpOnly, as the cookie contract in docs/ACCOUNT-AUTH.md says.
 * - `impersonating=1`: a hint, NOT HttpOnly and holding no personal data. A tiny inline script
 *   reads it on every page and shows the banner, so cached HTML never changes (no cache impact).
 *   The name in the banner comes from `/api/me` after load, and a stale hint corrects itself.
 */

export const SESSION_COOKIE = 'mc_session'
export const VIEW_AS_HINT_COOKIE = 'impersonating'

/** Path the CMS admin posts the one-time code to. */
export const VIEW_AS_START_PATH = '/account/view-as/start'
export const VIEW_AS_EXIT_PATH = '/account/view-as/exit'

/** Where a view starts on the site, and where Exit goes back to (the CMS admin, from site config). */
export const VIEW_AS_LANDING_PATH = '/account'

type CookieOptions = { secure: boolean }

const attributes = ({ secure }: CookieOptions): string =>
  `Path=/; SameSite=Lax${secure ? '; Secure' : ''}`

/** `Set-Cookie` values that begin a view: the HttpOnly session and the non-HttpOnly hint. */
export const viewAsCookies = ({
  expiresIn,
  secure,
  token,
}: CookieOptions & { expiresIn: number; token: string }): string[] => {
  const maxAge = Math.max(0, Math.floor(expiresIn))

  return [
    `${SESSION_COOKIE}=${token}; HttpOnly; Max-Age=${maxAge}; ${attributes({ secure })}`,
    `${VIEW_AS_HINT_COOKIE}=1; Max-Age=${maxAge}; ${attributes({ secure })}`,
  ]
}

/** `Set-Cookie` values that end a view. Clears the session too: an admin has no site session of their own to restore. */
export const clearViewAsCookies = ({ secure }: CookieOptions): string[] => [
  `${SESSION_COOKIE}=; HttpOnly; Max-Age=0; ${attributes({ secure })}`,
  `${VIEW_AS_HINT_COOKIE}=; Max-Age=0; ${attributes({ secure })}`,
]

export const readCookie = (header: null | string | undefined, name: string): null | string => {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }

  return null
}

/** True when the request's Origin is this site, so a form on another site cannot post to us. */
export const isSameOriginPost = (request: Request): boolean => {
  const origin = request.headers.get('origin')
  if (!origin) return false

  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export type ViewAsClient = {
  /** CMS origin. Site config, never request input. */
  cmsUrl: string
  fetch?: typeof fetch
  siteKey: string
  tenantSlug: string
}

const call = async (
  client: ViewAsClient,
  method: 'GET' | 'POST',
  action: string,
  { body, token }: { body?: unknown; token?: string } = {},
): Promise<{ body: Record<string, any> | null; status: number }> => {
  const response = await (client.fetch ?? fetch)(
    `${client.cmsUrl.replace(/\/$/, '')}/api/tenants/${encodeURIComponent(client.tenantSlug)}/account/${action}`,
    {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'content-type': 'application/json',
        'x-site-key': client.siteKey,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method,
    },
  )

  return { body: (await response.json().catch(() => null)) as Record<string, any> | null, status: response.status }
}

/** Swap the one-time code for the token. Null for anything the CMS refuses. */
export const redeemViewAsCode = async (
  client: ViewAsClient,
  code: unknown,
): Promise<null | { expiresIn: number; token: string }> => {
  if (typeof code !== 'string' || code.length < 20 || code.length > 100) return null

  const { body, status } = await call(client, 'POST', 'view-as/redeem', { body: { code } })

  return status === 200 && typeof body?.token === 'string' && typeof body.expiresIn === 'number'
    ? { expiresIn: body.expiresIn, token: body.token }
    : null
}

/** Ends the view on the CMS. Best effort: the cookies are cleared whatever this answers. */
export const endViewAs = async (client: ViewAsClient, token: null | string): Promise<void> => {
  if (!token) return

  await call(client, 'POST', 'view-as/exit', { token }).catch(() => {})
}

export type MeResult = { status: number; user: null | { firstName: null | string; lastName: null | string }; viewAs: boolean }

/** The signed-in user's name and whether this is a view-as session. Nothing else leaves the server. */
export const readMe = async (client: ViewAsClient, token: string): Promise<MeResult> => {
  const { body, status } = await call(client, 'GET', 'me', { token })
  const user = body?.user as { firstName?: null | string; lastName?: null | string } | undefined

  return {
    status,
    user: status === 200 && user ? { firstName: user.firstName ?? null, lastName: user.lastName ?? null } : null,
    viewAs: status === 200 && Boolean(body?.viewAs),
  }
}

/**
 * The tiny inline script, the same one that shows the signed-in hint. It runs on every page: if
 * the hint cookie is set it shows the banner, then asks `/api/me` for the name. A hint left over
 * from an ended or expired view removes itself. It never writes anything it did not read as text.
 */
export const VIEW_AS_BANNER_SCRIPT = `(function(){
var b=document.getElementById('mc-view-as');
if(!b||!/(?:^|;\\s*)impersonating=1(?:;|$)/.test(document.cookie))return;
b.hidden=false;
function drop(){document.cookie='impersonating=; Max-Age=0; Path=/';b.hidden=true}
fetch('/api/me',{credentials:'same-origin',headers:{accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(function(d){
if(!d||!d.viewAs){drop();return}
var n=[d.user&&d.user.firstName,d.user&&d.user.lastName].filter(Boolean).join(' ');
var e=b.querySelector('[data-view-as-name]');if(e&&n)e.textContent=n}).catch(function(){})
})();`
