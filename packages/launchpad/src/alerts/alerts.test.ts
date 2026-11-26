import { describe, expect, it } from 'vitest'

import {
  alertFilterFields,
  confirmNotice,
  createAlertsClient,
  manageLinkNotice,
  readManageForm,
  readSubscribeForm,
  subscribeNotice,
  unsubscribeNotice,
} from './index'

type Seen = { body: Record<string, unknown>; headers: Record<string, string>; url: string }

const clientWith = (respond: () => Response | Promise<Response>) => {
  const seen: Seen[] = []
  const client = createAlertsClient({
    baseUrl: 'https://cms.example.test/',
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({
        body: JSON.parse(String(init.body)),
        headers: init.headers as Record<string, string>,
        url,
      })
      return respond()
    }) as unknown as typeof fetch,
    siteKey: 'sk_secret',
    tenantSlug: 'vwok',
  })

  return { client, seen }
}

const json = (body: unknown, status = 200) => Response.json(body, { status })

describe('alerts client @S-085 @S-086 @S-087 @S-373', () => {
  it('posts to the tenant’s endpoint with the site key and the visitor’s IP, and never in the URL', async () => {
    const { client, seen } = clientWith(() => json({ ok: true, status: 'pending' }))

    const reply = await client.subscribe({
      clientIp: '203.0.113.9',
      email: 'jo@example.com',
      filters: { category: 'hospitality', q: 'cook' },
      frequency: 'weekly',
      turnstileToken: 'tok',
    })

    expect(reply).toEqual({ ok: true, status: 'pending' })
    expect(seen[0]!.url).toBe('https://cms.example.test/api/tenants/vwok/alerts/subscribe')
    expect(seen[0]!.headers).toMatchObject({ 'x-end-user-ip': '203.0.113.9', 'x-site-key': 'sk_secret' })
    expect(seen[0]!.url).not.toContain('sk_secret')
    expect(seen[0]!.body).toMatchObject({
      alert_website: '',
      email: 'jo@example.com',
      filters: { category: 'hospitality', q: 'cook' },
      frequency: 'weekly',
      turnstileToken: 'tok',
    })
  })

  it('forwards a signed-in visitor’s token the way the account contract says', async () => {
    const { client, seen } = clientWith(() => json({ ok: true, status: 'subscribed' }))
    await client.subscribe({ email: 'a@example.com', userToken: 'jwt-token' })

    expect(seen[0]!.headers.authorization).toBe('Bearer jwt-token')
  })

  it('turns a CMS error into a reply instead of throwing', async () => {
    const { client } = clientWith(() =>
      json({ error: { code: 'too_many_requests', message: 'Too many attempts.' } }, 429),
    )

    expect(await client.subscribe({ email: 'a@example.com' })).toEqual({
      code: 'too_many_requests',
      message: 'Too many attempts.',
      ok: false,
      status: 429,
    })
  })

  it('survives a network failure and a non-JSON answer', async () => {
    const down = createAlertsClient({
      baseUrl: 'https://cms.example.test',
      fetch: (async () => {
        throw new Error('boom')
      }) as unknown as typeof fetch,
      siteKey: 'sk',
      tenantSlug: 'vwok',
    })
    expect(await down.unsubscribe({ token: 'a.b' })).toMatchObject({ code: 'network', ok: false, status: 0 })

    const { client } = clientWith(() => new Response('<html>', { status: 502 }))
    expect(await client.unsubscribe({ token: 'a.b' })).toMatchObject({ code: 'server_error', ok: false, status: 502 })
  })

  it('does not treat a 200 without ok:true as success', async () => {
    const { client } = clientWith(() => json({ hello: 'world' }))

    expect(await client.confirm({ token: 'a.b' })).toMatchObject({ ok: false })
  })
})

describe('alert forms @S-373', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData()
    for (const [key, value] of Object.entries(entries)) data.set(key, value)
    return data
  }

  it('reads the subscribe form with the listing’s own filter names, trimmed', () => {
    expect(
      readSubscribeForm(
        form({
          alert_website: '',
          category: ' hospitality ',
          'cf-turnstile-response': 'tok',
          email: ' jo@example.com ',
          frequency: 'weekly',
          location: '',
          q: 'cook',
          unknown: 'ignored',
        }),
      ),
    ).toEqual({
      email: 'jo@example.com',
      filters: { category: 'hospitality', q: 'cook' },
      frequency: 'weekly',
      honeypot: '',
      turnstileToken: 'tok',
    })
  })

  it('leaves the frequency to the server’s default unless it is a real one', () => {
    expect(readSubscribeForm(form({ email: 'a@b.co', frequency: 'hourly' })).frequency).toBeUndefined()
    expect(readSubscribeForm(form({ email: 'a@b.co' })).frequency).toBeUndefined()
  })

  it('reads the manage form: a ticked box is active, an absent one is paused', () => {
    expect(readManageForm(form({ action: 'save', active: 'on', frequency: 'daily', id: '7' }))).toEqual({
      action: 'save',
      active: true,
      frequency: 'daily',
      id: '7',
    })
    expect(readManageForm(form({ action: 'save', id: '7' })).active).toBe(false)
  })

  it('carries the page’s filters into the form as hidden fields, omitting empty ones', () => {
    expect(alertFilterFields({ category: 'it', location: '', q: 'dev', page: '3' } as never)).toEqual([
      { name: 'q', value: 'dev' },
      { name: 'category', value: 'it' },
    ])
  })
})

describe('alert page wording @S-373', () => {
  const error = { code: 'invalid_token', message: 'This link is invalid or has expired.', ok: false, status: 400 } as const

  it('says "check your email" for a pending alert, and "saved" when it is already on', () => {
    expect(subscribeNotice({ ok: true, status: 'pending' })).toMatchObject({ kind: 'success', title: 'Check your email' })
    expect(subscribeNotice({ ok: true, status: 'subscribed' })).toMatchObject({ title: 'Job alert saved' })
  })

  it('tells a pending subscriber to open the email to start or manage the alert, whichever it is', () => {
    // The same page answers a new alert (confirm link) and a repeat of a live one (manage link),
    // and must not say which, so it must be true of both.
    const { message } = subscribeNotice({ ok: true, status: 'pending' })

    expect(message).toMatch(/start or manage/)
    expect(message).not.toMatch(/to start your job alert/)
  })

  it('shows the CMS’s own message for a refusal, with a title that says what went wrong', () => {
    expect(subscribeNotice({ code: 'disposable_email', message: 'Use a permanent email address.', ok: false, status: 400 })).toEqual({
      kind: 'error',
      message: 'Use a permanent email address.',
      title: 'We could not do that',
    })
    expect(confirmNotice(error)).toMatchObject({ kind: 'error', title: 'This link is not valid' })
  })

  it('confirms in the subscriber’s words and frequency', () => {
    const alert = { active: true, confirmed: true, frequency: 'weekly', id: 1, summary: '“cook” · Efate' } as const

    expect(confirmNotice({ alert, manageToken: 'x', ok: true }).message).toContain('once a week')
    expect(confirmNotice({ alert, manageToken: 'x', ok: true }).message).toContain('“cook” · Efate')
  })

  it('says the same thing whether or not the address has alerts', () => {
    expect(manageLinkNotice({ ok: true }).message).toMatch(/If this address has job alerts/)
  })

  it('tells a second click from the first, and does not claim other alerts stopped', () => {
    expect(unsubscribeNotice({ already: false, ok: true }).message).toContain('Your other alerts')
    expect(unsubscribeNotice({ already: true, ok: true })).toMatchObject({ kind: 'info', title: 'Already unsubscribed' })
  })
})
