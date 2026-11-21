import { describe, expect, it, vi } from 'vitest'

import {
  clearViewAsCookies,
  endViewAs,
  isSameOriginPost,
  readCookie,
  readMe,
  redeemViewAsCode,
  SESSION_COOKIE,
  VIEW_AS_BANNER_SCRIPT,
  VIEW_AS_HINT_COOKIE,
  viewAsCookies,
  type ViewAsClient,
} from './index'

const client = (response: { body?: unknown; status?: number }, spy = vi.fn()): ViewAsClient => ({
  cmsUrl: 'https://cms.example/',
  fetch: (async (...args: unknown[]) => {
    spy(...args)

    return Response.json(response.body ?? {}, { status: response.status ?? 200 })
  }) as typeof fetch,
  siteKey: 'sk_test',
  tenantSlug: 'vwok',
})

describe('view-as cookies @S-160', () => {
  it('sets an HttpOnly session and a hint script can read, both 30 minutes, with no personal data', () => {
    const [session, hint] = viewAsCookies({ expiresIn: 1800, secure: true, token: 'mcva1.abc.def' })

    expect(session).toBe(`${SESSION_COOKIE}=mcva1.abc.def; HttpOnly; Max-Age=1800; Path=/; SameSite=Lax; Secure`)
    expect(hint).toBe(`${VIEW_AS_HINT_COOKIE}=1; Max-Age=1800; Path=/; SameSite=Lax; Secure`)
    expect(hint).not.toContain('HttpOnly')
  })

  it('drops Secure only when asked, for localhost', () => {
    expect(viewAsCookies({ expiresIn: 5, secure: false, token: 't' }).join()).not.toContain('Secure')
  })

  it('clears both cookies on exit', () => {
    const cleared = clearViewAsCookies({ secure: true })

    expect(cleared).toHaveLength(2)
    expect(cleared.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true)
  })

  it('reads a cookie by name', () => {
    expect(readCookie('a=1; mc_session=tok=en; b=2', 'mc_session')).toBe('tok=en')
    expect(readCookie('a=1', 'mc_session')).toBeNull()
    expect(readCookie(null, 'a')).toBeNull()
  })
})

describe('same-origin check for exit @S-157', () => {
  const post = (origin?: string) =>
    new Request('https://vanuatuwok.vu/account/view-as/exit', {
      headers: origin ? { origin } : {},
      method: 'POST',
    })

  it('accepts this site and refuses another site or no origin', () => {
    expect(isSameOriginPost(post('https://vanuatuwok.vu'))).toBe(true)
    expect(isSameOriginPost(post('https://evil.example'))).toBe(false)
    expect(isSameOriginPost(post('https://vanuatuwok.vu.evil.example'))).toBe(false)
    expect(isSameOriginPost(post())).toBe(false)
    expect(isSameOriginPost(post('null'))).toBe(false)
  })
})

describe('talking to the CMS @S-157', () => {
  it('redeems a code with the site key, server to server', async () => {
    const spy = vi.fn()
    const result = await redeemViewAsCode(client({ body: { expiresIn: 1790, token: 'mcva1.a.b' } }, spy), 'x'.repeat(43))

    expect(result).toEqual({ expiresIn: 1790, token: 'mcva1.a.b' })
    expect(spy).toHaveBeenCalledWith(
      'https://cms.example/api/tenants/vwok/account/view-as/redeem',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-site-key': 'sk_test' }), method: 'POST' }),
    )
  })

  it('returns null for a refused or malformed code without calling the CMS for the latter', async () => {
    const spy = vi.fn()

    expect(await redeemViewAsCode(client({ body: { error: {} }, status: 400 }), 'x'.repeat(43))).toBeNull()
    expect(await redeemViewAsCode(client({}, spy), 'short')).toBeNull()
    expect(await redeemViewAsCode(client({}, spy), undefined)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('exits with the token, and does nothing without one', async () => {
    const spy = vi.fn()
    await endViewAs(client({}, spy), 'mcva1.a.b')
    await endViewAs(client({}, spy), null)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![1].headers.authorization).toBe('Bearer mcva1.a.b')
  })

  it('reads only the name and the viewing flag from me', async () => {
    const me = await readMe(
      client({ body: { user: { email: 'a@b.co', firstName: 'Ada', id: 9, lastName: 'L', role: 'seeker' }, viewAs: { expiresAt: 'x' } } }),
      't',
    )

    expect(me).toEqual({ status: 200, user: { firstName: 'Ada', lastName: 'L' }, viewAs: true })
    expect(await readMe(client({ body: { user: { firstName: 'A' } } }), 't')).toMatchObject({ viewAs: false })
    expect(await readMe(client({ body: {}, status: 401 }), 't')).toEqual({ status: 401, user: null, viewAs: false })
  })
})

describe('banner script @S-160', () => {
  it('is small, reads the hint cookie, and sets names as text', () => {
    expect(VIEW_AS_BANNER_SCRIPT.length).toBeLessThan(1200)
    expect(VIEW_AS_BANNER_SCRIPT).toContain('impersonating=1')
    expect(VIEW_AS_BANNER_SCRIPT).toContain('textContent')
    expect(VIEW_AS_BANNER_SCRIPT).not.toContain('innerHTML')
  })

  it('does nothing without the hint, shows the banner with it, and drops a stale hint', async () => {
    const run = async (cookie: string, me: null | { viewAs?: unknown; user?: unknown }) => {
      const banner = { hidden: true, name: '', querySelector: () => ({ set textContent(value: string) { banner.name = value } }) }
      const doc = { cookie, getElementById: () => banner }
      const fetchMock = vi.fn(async () => ({ json: async () => me, ok: me !== null }))

      new Function('document', 'fetch', VIEW_AS_BANNER_SCRIPT)(doc, fetchMock)
      await new Promise((resolve) => setTimeout(resolve, 0))

      return { banner, doc, fetchMock }
    }

    const none = await run('a=1', null)
    expect(none.banner.hidden).toBe(true)
    expect(none.fetchMock).not.toHaveBeenCalled()

    const active = await run('a=1; impersonating=1', { user: { firstName: 'Ada', lastName: 'L' }, viewAs: true })
    expect(active.banner.hidden).toBe(false)
    expect(active.banner.name).toBe('Ada L')

    const stale = await run('impersonating=1', { user: {}, viewAs: false })
    expect(stale.banner.hidden).toBe(true)
    expect(stale.doc.cookie).toContain('Max-Age=0')
  })
})
