import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleSignInRequest, handleSignInSubmit, handleSignOut, type SignInEnv } from './sign-in-handlers'

const env: SignInEnv = { CMS_URL: 'https://cms.example', SITE_KEY: 'sk_test' }
const ORIGIN = 'https://vanuatuwok.vu'

afterEach(() => vi.unstubAllGlobals())

const mockCMS = (response: { body?: unknown; status?: number }) => {
  const spy = vi.fn(async (..._args: unknown[]) => Response.json(response.body ?? {}, { status: response.status ?? 200 }))
  vi.stubGlobal('fetch', spy)

  return spy
}

const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) =>
  new Request(`${ORIGIN}${path}`, { body: new URLSearchParams(fields), headers, method: 'POST' })

const cookies = (response: Response) => response.headers.getSetCookie()

describe('sign in: ask for a code @S-196', () => {
  it('sends the form to the CMS and moves to the code page, keeping the address out of the URL', async () => {
    const spy = mockCMS({ status: 202 })
    const response = await handleSignInRequest(
      post('/account/sign-in/request', {
        'cf-turnstile-response': 'tok',
        email: 'Ada@Example.test',
        keepSignedIn: 'on',
        returnTo: '/account/saved-jobs',
      }),
      env,
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account/sign-in/code?returnTo=%2Faccount%2Fsaved-jobs')
    expect(response.headers.get('location')).not.toMatch(/ada|example/i)
    expect(cookies(response)).toEqual([
      'mc_sign_in_email=ada%40example.test; HttpOnly; Max-Age=900; Path=/account/sign-in; SameSite=Lax; Secure',
    ])

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string)
    expect(body).toEqual({
      email: 'ada@example.test',
      keepSignedIn: true,
      returnTo: '/account/saved-jobs',
      turnstileToken: 'tok',
    })
  })

  it('treats an unticked box as "default session" and drops a hostile return path', async () => {
    const spy = mockCMS({ status: 202 })
    const response = await handleSignInRequest(
      post('/account/sign-in/request', { email: 'a@b.test', returnTo: 'https://evil.example' }),
      env,
    )

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.keepSignedIn).toBe(false)
    expect(body.returnTo).toBeUndefined()
    expect(response.headers.get('location')).toBe('/account/sign-in/code')
  })

  it('goes back to the form with a reason when the CMS refuses, and sets no cookie', async () => {
    mockCMS({ body: { error: { code: 'turnstile_failed' } }, status: 400 })
    const failed = await handleSignInRequest(post('/account/sign-in/request', { email: 'a@b.test' }), env)

    expect(failed.headers.get('location')).toBe('/account/sign-in?error=turnstile_failed')
    expect(cookies(failed)).toEqual([])

    mockCMS({ status: 429 })
    expect(
      (await handleSignInRequest(post('/account/sign-in/request', { email: 'a@b.test' }), env)).headers.get('location'),
    ).toBe('/account/sign-in?error=rate_limited')
  })

  it('refuses another site, and a missing configuration, without calling the CMS', async () => {
    const spy = mockCMS({ status: 202 })

    expect((await handleSignInRequest(post('/x', { email: 'a@b.test' }, { origin: 'https://evil.example' }), env)).status).toBe(403)
    expect((await handleSignInRequest(post('/x', { email: 'a@b.test' }, {}), env)).status).toBe(403)
    expect((await handleSignInRequest(post('/x', { email: 'a@b.test' }), {})).status).toBe(503)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('sign in: finish with the code or the link @S-196', () => {
  const ok = { body: { expiresIn: 86_400, returnTo: null, token: 'jwt.a.b' } }

  it('sets the session and the hint with one expiry, clears the address cookie and lands on the account', async () => {
    mockCMS(ok)
    const response = await handleSignInSubmit(
      post('/account/sign-in/submit', { code: '123 456' }, { cookie: 'mc_sign_in_email=ada%40example.test', origin: ORIGIN }),
      env,
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account')
    expect(cookies(response)).toEqual([
      'mc_session=jwt.a.b; HttpOnly; Max-Age=86400; Path=/; SameSite=Lax; Secure',
      'signed_in=1; Max-Age=86400; Path=/; SameSite=Lax; Secure',
      'mc_sign_in_email=; HttpOnly; Max-Age=0; Path=/account/sign-in; SameSite=Lax; Secure',
    ])
  })

  it('sends the code with the address from the cookie, or the link token alone', async () => {
    const spy = mockCMS(ok)

    await handleSignInSubmit(
      post('/s', { code: '123456' }, { cookie: 'mc_sign_in_email=ada%40example.test', origin: ORIGIN }),
      env,
    )
    await handleSignInSubmit(post('/s', { code: '999999', token: 'abc' }), env)

    expect(JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      code: '123456',
      email: 'ada@example.test',
    })
    expect(JSON.parse((spy.mock.calls[1]![1] as RequestInit).body as string)).toEqual({ token: 'abc' })
  })

  it('returns to the page the visitor came from, preferring the one the CMS stored', async () => {
    mockCMS({ body: { expiresIn: 60, returnTo: '/account/saved-jobs', token: 't' } })
    expect(
      (await handleSignInSubmit(post('/s', { token: 'abc', returnTo: '/jobs' }), env)).headers.get('location'),
    ).toBe('/account/saved-jobs')

    mockCMS(ok)
    expect((await handleSignInSubmit(post('/s', { token: 'abc', returnTo: '/jobs' }), env)).headers.get('location')).toBe('/jobs')
    expect(
      (await handleSignInSubmit(post('/s', { token: 'abc', returnTo: 'https://evil.example' }), env)).headers.get('location'),
    ).toBe('/account')
  })

  it('keeps a wrong code on the code page and a dead link on the start page, with no cookies', async () => {
    mockCMS({ status: 400 })
    const code = await handleSignInSubmit(post('/s', { code: '000000', email: 'a@b.test', returnTo: '/jobs' }), env)
    const link = await handleSignInSubmit(post('/s', { token: 'dead' }), env)

    expect(code.headers.get('location')).toBe('/account/sign-in/code?error=invalid_code&returnTo=%2Fjobs')
    expect(link.headers.get('location')).toBe('/account/sign-in?error=link')
    expect(cookies(code)).toEqual([])
    expect(cookies(link)).toEqual([])
  })

  it('refuses another site, so a link scanner or a form elsewhere cannot spend a token', async () => {
    const spy = mockCMS(ok)

    expect((await handleSignInSubmit(post('/s', { token: 'abc' }, { origin: 'https://evil.example' }), env)).status).toBe(403)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('sign out @S-082', () => {
  it('ends the session on the CMS and clears both cookies', async () => {
    const spy = mockCMS({})
    const response = await handleSignOut(
      post('/account/sign-out', {}, { cookie: 'mc_session=jwt.a.b; signed_in=1', origin: ORIGIN }),
      env,
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    expect(cookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
    expect(cookies(response).map((cookie) => cookie.split('=')[0])).toEqual(['mc_session', 'signed_in', 'mc_sign_in_email'])
    expect(spy).toHaveBeenCalledWith(
      'https://cms.example/api/tenants/vwok/account/logout',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer jwt.a.b' }) }),
    )
  })

  it('still clears the cookies when the CMS is down, and refuses another site', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))

    const response = await handleSignOut(post('/account/sign-out', {}, { cookie: 'mc_session=t', origin: ORIGIN }), env)
    expect(cookies(response)).toHaveLength(3)

    expect((await handleSignOut(post('/account/sign-out', {}, { origin: 'https://evil.example' }), env)).status).toBe(403)
  })
})
