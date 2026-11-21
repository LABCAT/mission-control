import { describe, expect, it, vi } from 'vitest'

import { handleMe, handleViewAsExit, handleViewAsStart, type ViewAsEnv } from './view-as-handlers'

const env: ViewAsEnv = { CMS_URL: 'https://cms.example', SITE_KEY: 'sk_test' }
const CODE = 'c'.repeat(43)

const mockCMS = (response: { body?: unknown; status?: number }) => {
  const spy = vi.fn(async () => Response.json(response.body ?? {}, { status: response.status ?? 200 }))
  vi.stubGlobal('fetch', spy)

  return spy
}

const start = (fields: Record<string, string>, url = 'https://vanuatuwok.vu/account/view-as/start') =>
  new Request(url, { body: new URLSearchParams(fields), method: 'POST' })

const exit = (headers: Record<string, string> = {}) =>
  new Request('https://vanuatuwok.vu/account/view-as/exit', { headers, method: 'POST' })

const setCookies = (response: Response) => response.headers.getSetCookie()

describe('view as: start @S-073', () => {
  it('swaps the code for a 30 minute session and lands on the account, with both cookies', async () => {
    const spy = mockCMS({ body: { expiresIn: 1800, token: 'mcva1.a.b' } })
    const response = await handleViewAsStart(start({ code: CODE }), env)

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(setCookies(response)).toEqual([
      'mc_session=mcva1.a.b; HttpOnly; Max-Age=1800; Path=/; SameSite=Lax; Secure',
      'impersonating=1; Max-Age=1800; Path=/; SameSite=Lax; Secure',
    ])
    expect(spy).toHaveBeenCalledOnce()
  })

  it('does not put the token or code anywhere a visitor could read, other than the cookies', async () => {
    mockCMS({ body: { expiresIn: 1800, token: 'mcva1.secret.token' } })
    const response = await handleViewAsStart(start({ code: CODE }), env)

    expect(response.headers.get('location')).not.toMatch(/mcva1|code/)
    expect(await response.text()).toBe('')
  })

  it('refuses a code the CMS refuses, an empty post, and a missing config', async () => {
    mockCMS({ body: { error: { code: 'invalid_token' } }, status: 400 })
    expect((await handleViewAsStart(start({ code: CODE }), env)).status).toBe(400)
    expect((await handleViewAsStart(start({}), env)).status).toBe(400)
    expect((await handleViewAsStart(start({ code: CODE }), {})).status).toBe(503)

    const response = await handleViewAsStart(start({ code: CODE }), env)
    expect(setCookies(response)).toEqual([])
  })

  it('drops Secure on http for local development', async () => {
    mockCMS({ body: { expiresIn: 60, token: 't' } })
    const response = await handleViewAsStart(start({ code: CODE }, 'http://localhost:4321/account/view-as/start'), env)

    expect(setCookies(response).join()).not.toContain('Secure')
  })
})

describe('view as: exit @S-157', () => {
  it('ends the view on the CMS, clears both cookies and returns to the admin', async () => {
    const spy = mockCMS({})
    const response = await handleViewAsExit(
      exit({ cookie: 'mc_session=mcva1.a.b; impersonating=1', origin: 'https://vanuatuwok.vu' }),
      env,
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://cms.example/admin')
    expect(setCookies(response).every((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
    expect(spy).toHaveBeenCalledWith(
      'https://cms.example/api/tenants/vwok/account/view-as/exit',
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer mcva1.a.b' }) }),
    )
  })

  it('is refused for a request from another site or without an origin, and changes nothing', async () => {
    const spy = mockCMS({})

    for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
      const response = await handleViewAsExit(exit({ cookie: 'mc_session=mcva1.a.b', ...headers }), env)

      expect(response.status).toBe(403)
      expect(setCookies(response)).toEqual([])
    }

    expect(spy).not.toHaveBeenCalled()
  })

  it('still clears the cookies when the CMS is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    const response = await handleViewAsExit(exit({ cookie: 'mc_session=t', origin: 'https://vanuatuwok.vu' }), env)

    expect(response.status).toBe(303)
    expect(setCookies(response)).toHaveLength(2)
  })
})

describe('view as: /api/me for the banner @S-160', () => {
  const me = (cookie?: string) =>
    new Request('https://vanuatuwok.vu/api/me', { headers: cookie ? { cookie } : {} })

  it('returns only the name and the viewing flag, uncached', async () => {
    mockCMS({ body: { user: { email: 'a@b.co', firstName: 'Ada', id: 5, lastName: 'L', role: 'seeker' }, viewAs: { expiresAt: 'x' } } })
    const response = await handleMe(me('mc_session=mcva1.a.b'), env)

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ user: { firstName: 'Ada', lastName: 'L' }, viewAs: true })
  })

  it('clears a stale hint when the CMS no longer accepts the token or there is no session', async () => {
    mockCMS({ body: {}, status: 401 })

    for (const cookie of ['mc_session=expired', undefined]) {
      const response = await handleMe(me(cookie), env)

      expect(response.status).toBe(401)
      expect(setCookies(response)[0]).toMatch(/^impersonating=; Max-Age=0/)
    }
  })
})
