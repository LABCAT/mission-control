import { describe, expect, it, vi } from 'vitest'

import {
  clearSignInCookies,
  readSession,
  requestSignInCode,
  safeReturnPath,
  SIGNED_IN_SCRIPT,
  signInCookies,
  signInUrl,
  verifySignIn,
  type SignInClient,
} from './index'

const client = (response: { body?: unknown; status?: number }, spy = vi.fn()): SignInClient => ({
  cmsUrl: 'https://cms.example/',
  fetch: (async (...args: unknown[]) => {
    spy(...args)

    return Response.json(response.body ?? {}, { status: response.status ?? 200 })
  }) as typeof fetch,
  siteKey: 'sk_test',
  tenantSlug: 'vwok',
})

describe('sign-in cookies @S-082', () => {
  it('sets an HttpOnly session and a hint with the same expiry and no personal data', () => {
    const [session, hint] = signInCookies({ expiresIn: 2_592_000, secure: true, token: 'jwt.a.b' })

    expect(session).toBe('mc_session=jwt.a.b; HttpOnly; Max-Age=2592000; Path=/; SameSite=Lax; Secure')
    expect(hint).toBe('signed_in=1; Max-Age=2592000; Path=/; SameSite=Lax; Secure')
    expect(hint).not.toContain('HttpOnly')
    expect(hint).not.toMatch(/jwt|@/)
  })

  it('matches the hint to the session whatever the length (1 day unticked, 30 days ticked)', () => {
    for (const expiresIn of [86_400, 30 * 86_400]) {
      const [session, hint] = signInCookies({ expiresIn, secure: false, token: 't' })

      expect(session).toContain(`Max-Age=${expiresIn}`)
      expect(hint).toContain(`Max-Age=${expiresIn}`)
      expect(session).not.toContain('Secure')
    }
  })

  it('clears both cookies on sign-out', () => {
    const cookies = clearSignInCookies({ secure: true })

    expect(cookies).toHaveLength(2)
    expect(cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
    expect(cookies.map((cookie) => cookie.split('=')[0])).toEqual(['mc_session', 'signed_in'])
  })
})

describe('return path @S-081', () => {
  it('keeps a path on the site and refuses everything else', () => {
    expect(safeReturnPath('/account/saved-jobs')).toBe('/account/saved-jobs')

    for (const value of ['https://evil.example', '//evil.example', '/\\evil', 'javascript:alert(1)', '', null, 5]) {
      expect(safeReturnPath(value)).toBeNull()
    }
  })

  it('builds the sign-in URL for a protected page, and never loops back to sign-in', () => {
    expect(signInUrl('/account/saved-jobs?page=2')).toBe(
      '/account/sign-in?returnTo=%2Faccount%2Fsaved-jobs%3Fpage%3D2',
    )
    expect(signInUrl('https://evil.example')).toBe('/account/sign-in')
    expect(signInUrl('/account/sign-in/code')).toBe('/account/sign-in')
    expect(signInUrl(undefined)).toBe('/account/sign-in')
  })
})

describe('requestSignInCode', () => {
  it('posts to the tenant endpoint with the site key, the visitor IP and a safe return path', async () => {
    const spy = vi.fn()
    const result = await requestSignInCode(client({ status: 202 }, spy), {
      email: 'a@b.test',
      ip: '203.0.113.5',
      keepSignedIn: true,
      returnTo: '//evil.example',
      turnstileToken: 'tok',
    })

    expect(result).toEqual({ ok: true })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cms.example/api/tenants/vwok/account/sign-in/request')
    expect(init.headers).toMatchObject({ 'x-end-user-ip': '203.0.113.5', 'x-site-key': 'sk_test' })
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'a@b.test',
      keepSignedIn: true,
      turnstileToken: 'tok',
    })
  })

  it('maps the CMS errors to messages the page can show', async () => {
    const input = { email: 'a@b.test', keepSignedIn: false, turnstileToken: '' }

    expect(await requestSignInCode(client({ status: 429 }), input)).toEqual({ error: 'rate_limited' })
    expect(
      await requestSignInCode(client({ body: { error: { code: 'turnstile_failed' } }, status: 400 }), input),
    ).toEqual({ error: 'turnstile_failed' })
    expect(await requestSignInCode(client({ status: 400 }), input)).toEqual({ error: 'invalid_request' })
    expect(await requestSignInCode(client({ status: 500 }), input)).toEqual({ error: 'unavailable' })
  })
})

describe('verifySignIn', () => {
  it('returns the token, its length and a return path that stays on the site', async () => {
    const result = await verifySignIn(
      client({ body: { expiresIn: 86_400, returnTo: '/account', token: 'jwt' } }),
      { code: '123456', email: 'a@b.test' },
    )

    expect(result).toEqual({ expiresIn: 86_400, ok: true, returnTo: '/account', token: 'jwt' })

    const hostile = await verifySignIn(
      client({ body: { expiresIn: 5, returnTo: 'https://evil.example', token: 'jwt' } }),
      { token: 'abc' },
    )
    expect(hostile).toMatchObject({ ok: true, returnTo: null })
  })

  it('sends the link token alone, or the code with the address', async () => {
    const spy = vi.fn()
    await verifySignIn(client({ status: 400 }, spy), { code: 'ignored', token: 'abc' })
    await verifySignIn(client({ status: 400 }, spy), { code: '123456', email: 'a@b.test' })

    expect(JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string)).toEqual({ token: 'abc' })
    expect(JSON.parse((spy.mock.calls[1] as [string, RequestInit])[1].body as string)).toEqual({
      code: '123456',
      email: 'a@b.test',
    })
  })

  it('does not return a session for a refusal', async () => {
    expect(await verifySignIn(client({ status: 400 }), { token: 'x' })).toEqual({ error: 'invalid_code' })
    expect(await verifySignIn(client({ status: 429 }), { token: 'x' })).toEqual({ error: 'rate_limited' })
    expect(await verifySignIn(client({ status: 503 }), { token: 'x' })).toEqual({ error: 'unavailable' })
    expect(await verifySignIn(client({ body: { token: 'jwt' } }), { token: 'x' })).toEqual({ error: 'unavailable' })
  })
})

describe('readSession', () => {
  it('passes on a renewed token from the CMS and nothing but the name', async () => {
    const me = await readSession(
      client({
        body: {
          session: { exp: 1, expiresIn: 2_592_000, token: 'new' },
          user: { email: 'a@b.test', firstName: 'Ada', id: 1, lastName: null, role: 'seeker' },
        },
      }),
      'old',
    )

    expect(me).toEqual({
      renewed: { expiresIn: 2_592_000, token: 'new' },
      status: 200,
      user: { firstName: 'Ada', lastName: null },
      viewAs: false,
    })
  })

  it('reports a refused token', async () => {
    expect(await readSession(client({ status: 401 }), 'old')).toMatchObject({ renewed: null, status: 401, user: null })
  })
})

describe('signed-in script @S-082', () => {
  it('does nothing without the hint cookie, and reads only the cookie it needs', () => {
    expect(SIGNED_IN_SCRIPT).toContain('signed_in=1')
    expect(SIGNED_IN_SCRIPT).toContain('/api/me')
    // A stale hint (401) removes itself and restores the link.
    expect(SIGNED_IN_SCRIPT).toContain('status!==401')
    expect(SIGNED_IN_SCRIPT).toContain('signed_in=; Max-Age=0')
  })

  it('swaps the link and puts it back, in a browser-like document', () => {
    const attributes = new Map<string, string>([['href', '/account/sign-in?returnTo=%2Fjobs']])
    const link = {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      textContent: 'Sign in',
    }
    let resolveFetch: (value: { status: number }) => void = () => {}
    const document = {
      cookie: 'a=1; signed_in=1',
      querySelectorAll: () => [link],
    }
    const fetchSpy = vi.fn(() => new Promise((resolve) => (resolveFetch = resolve as never)))

    new Function('document', 'fetch', SIGNED_IN_SCRIPT)(document, fetchSpy)

    // Swapped before any request finishes, so nothing shifts.
    expect(attributes.get('href')).toBe('/account')
    expect(link.textContent).toBe('My account')

    resolveFetch({ status: 401 })

    return Promise.resolve().then(() => Promise.resolve()).then(() => {
      expect(attributes.get('href')).toBe('/account/sign-in?returnTo=%2Fjobs')
      expect(link.textContent).toBe('Sign in')
      expect(document.cookie).toBe('signed_in=; Max-Age=0; Path=/')
    })
  })

  it('leaves the page alone when the hint is missing', () => {
    const querySelectorAll = vi.fn()

    new Function('document', 'fetch', SIGNED_IN_SCRIPT)({ cookie: 'x=1', querySelectorAll }, vi.fn())

    expect(querySelectorAll).not.toHaveBeenCalled()
  })
})
