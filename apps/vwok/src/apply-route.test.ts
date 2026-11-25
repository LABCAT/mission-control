import { describe, expect, it, vi } from 'vitest'

import { APPLY_BODY_MAX_BYTES, applyRoute, bodyTooLarge, forwardApplication } from './apply-route'

const job = (overrides: Record<string, unknown> = {}) => ({
  applyOnline: true,
  expiresAt: '2099-01-01T00:00:00.000Z',
  id: 7,
  organisation: { id: 3, name: 'Acme', slug: 'acme' },
  slug: 'welder',
  status: 'published',
  title: 'Welder',
  ...overrides,
})

const cmsWith = (doc: unknown, settings: Record<string, unknown> = {}) => ({
  find: async () => ({ docs: [], totalDocs: 0 }) as never,
  findBySlug: async () => doc as never,
  tenantSettings: async () => settings as never,
})

const env = { CMS_URL: 'https://cms.example/', SITE_KEY: 'sk_site' }

const formRequest = (cookie?: string) => {
  const body = new FormData()
  body.set('name', 'Ada')
  body.set('cv', new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], 'cv.pdf'))

  return new Request('https://vanuatuwok.vu/jobs/welder/apply', {
    body,
    headers: cookie ? { cookie } : {},
    method: 'POST',
  })
}

describe('apply route (GET)', () => {
  it('shows the form for a live job @S-049', async () => {
    const route = await applyRoute({ cms: cmsWith(job()), cookie: null, now: new Date('2026-11-23T00:00:00Z'), slug: 'welder' })

    expect(route).toMatchObject({ kind: 'form' })
  })

  it('is a 404 for an unknown job and a closed page for an expired one @S-282', async () => {
    expect((await applyRoute({ cms: cmsWith(null), cookie: null, slug: 'x' })).kind).toBe('not-found')

    const expired = await applyRoute({
      cms: cmsWith(job({ expiresAt: '2026-11-20T00:00:00.000Z', status: 'expired' })),
      cookie: null,
      now: new Date('2026-11-23T00:00:00Z'),
      slug: 'welder',
    })
    expect(expired.kind).toBe('closed')
  })

  it('says online applying is off, with no form @S-032', async () => {
    const route = await applyRoute({ cms: cmsWith(job({ applyOnline: false })), cookie: null, now: new Date('2026-11-23T00:00:00Z'), slug: 'welder' })

    expect(route).toMatchObject({ kind: 'closed' })
  })

  it('sends a guest to sign in, with the return path, when the site requires an account @S-050', async () => {
    const route = await applyRoute({ cms: cmsWith(job(), { accountRequiredToApply: true }), cookie: null, now: new Date('2026-11-23T00:00:00Z'), slug: 'welder' })

    expect(route).toEqual({ kind: 'redirect', location: '/account/sign-in?return=%2Fjobs%2Fwelder%2Fapply' })
  })

  it('shows the form to a visitor holding a session when the site requires an account @S-050', async () => {
    const route = await applyRoute({
      cms: cmsWith(job(), { accountRequiredToApply: true }),
      cookie: 'mc_session=abc',
      now: new Date('2026-11-23T00:00:00Z'),
      slug: 'welder',
    })

    expect(route.kind).toBe('form')
  })
})

describe('forwardApplication (POST)', () => {
  it('posts the multipart form to the CMS with the site key, visitor IP and session, and returns the outcome @S-049', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.body).toBeInstanceOf(FormData)
      return Response.json({ ok: true }, { status: 201 })
    })
    const outcome = await forwardApplication({
      clientAddress: '203.0.113.9',
      env,
      fetcher: fetcher as never,
      jobId: 7,
      request: formRequest('mc_session=abc'),
    })

    expect(outcome).toEqual({ kind: 'sent' })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://cms.example/api/jobs/7/apply')
    const headers = new Headers(init.headers)
    expect(headers.get('x-site-key')).toBe('sk_site')
    expect(headers.get('x-end-user-ip')).toBe('203.0.113.9')
    expect(headers.get('authorization')).toBe('JWT abc')
    expect((init.body as FormData).get('name')).toBe('Ada')
    expect(((init.body as FormData).get('cv') as File).name).toBe('cv.pdf')
  })

  it('maps CMS validation errors for the form @S-049', async () => {
    const fetcher = async () =>
      Response.json(
        { error: { code: 'invalid_values', errors: [{ field: 'cv', message: 'Attach your CV.' }], message: 'Attach your CV.' } },
        { status: 400 },
      )
    const outcome = await forwardApplication({ clientAddress: '1.1.1.1', env, fetcher: fetcher as never, jobId: 7, request: formRequest() })

    expect(outcome).toMatchObject({ errors: [{ field: 'cv' }], kind: 'invalid' })
  })

  it('reports an unreachable CMS or missing configuration as an error, not a crash', async () => {
    const down = async () => {
      throw new Error('boom')
    }
    expect((await forwardApplication({ clientAddress: '1.1.1.1', env, fetcher: down as never, jobId: 7, request: formRequest() })).kind).toBe('error')
    expect((await forwardApplication({ clientAddress: '1.1.1.1', env: {}, jobId: 7, request: formRequest() })).kind).toBe('error')
  })

  it('refuses a body that is not a form', async () => {
    const request = new Request('https://vanuatuwok.vu/jobs/welder/apply', { body: '{}', headers: { 'content-type': 'application/json' }, method: 'POST' })

    expect((await forwardApplication({ clientAddress: '1.1.1.1', env, jobId: 7, request })).kind).toBe('error')
  })
})

describe('body size guard', () => {
  const post = (headers: Record<string, string>) =>
    new Request('https://vanuatuwok.vu/jobs/welder/apply', { body: 'x', headers, method: 'POST' })

  it('allows a body up to the cap and refuses one over it, a missing length or a nonsense one @S-049', () => {
    expect(bodyTooLarge(post({ 'content-length': String(APPLY_BODY_MAX_BYTES) }))).toBe(false)
    expect(bodyTooLarge(post({ 'content-length': String(APPLY_BODY_MAX_BYTES + 1) }))).toBe(true)
    expect(bodyTooLarge(post({}))).toBe(true)
    expect(bodyTooLarge(post({ 'content-length': 'abc' }))).toBe(true)
  })

  it('parses the form once: a pre-parsed form is forwarded without reading the request body again', async () => {
    const request = formRequest()
    const form = await request.formData()
    const spy = vi.spyOn(request, 'formData')
    const fetcher = vi.fn(async () => Response.json({ ok: true }, { status: 201 }))

    const outcome = await forwardApplication({ clientAddress: '1.1.1.1', env, fetcher: fetcher as never, form, jobId: 7, request })

    expect(outcome).toEqual({ kind: 'sent' })
    expect(spy).not.toHaveBeenCalled()
    expect(((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body).toBe(form)
  })
})
