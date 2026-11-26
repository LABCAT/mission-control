import type { AlertsClient } from '@mission-control/launchpad/alerts'
import { describe, expect, it, vi } from 'vitest'

import {
  alertsClientFromEnv,
  confirmPage,
  managePage,
  manageRequestPage,
  subscribePage,
  unsubscribePage,
} from './alerts'

const ok = <T extends object>(value: T) => ({ ok: true as const, ...value })
const refused = (code: string, status = 400, message = 'No.') => ({ code, message, ok: false as const, status })

const clientWith = (overrides: Partial<AlertsClient> = {}): AlertsClient => ({
  confirm: vi.fn(async () => refused('invalid_token')),
  list: vi.fn(async () => ok({ alerts: [] })),
  remove: vi.fn(async () => ok({})),
  requestManageLink: vi.fn(async () => ok({})),
  subscribe: vi.fn(async () => ok({ status: 'pending' as const })),
  unsubscribe: vi.fn(async () => ok({ already: false })),
  update: vi.fn(async () => refused('alert_not_found', 404)),
  ...overrides,
})

const post = (path: string, fields: Record<string, string>) =>
  new Request(`https://vanuatuwok.vu${path}`, { body: new URLSearchParams(fields), method: 'POST' })
const get = (path: string) => new Request(`https://vanuatuwok.vu${path}`)

const alert = { active: true, confirmed: true, frequency: 'daily', id: 5, summary: '“cook”' } as const

describe('alertsClientFromEnv', () => {
  it('needs both the CMS address and the site key, like the rest of the site', () => {
    expect(alertsClientFromEnv({})).toBeNull()
    expect(alertsClientFromEnv({ CMS_URL: 'https://cms.test' })).toBeNull()
    expect(alertsClientFromEnv({ CMS_URL: 'https://cms.test', SITE_KEY: 'sk_x' })).not.toBeNull()
  })
})

describe('alert pages without JavaScript @S-085 @S-086 @S-087 @S-373', () => {
  it('subscribing passes the form and the visitor’s IP to the CMS, and says to check email', async () => {
    const client = clientWith()
    const page = await subscribePage(
      client,
      post('/alerts/subscribe', { category: 'hospitality', email: 'jo@example.com', frequency: 'weekly' }),
      { clientIp: '203.0.113.7' },
    )

    expect(client.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        clientIp: '203.0.113.7',
        email: 'jo@example.com',
        filters: { category: 'hospitality' },
        frequency: 'weekly',
      }),
    )
    expect(page).toMatchObject({ kind: 'notice', notice: { title: 'Check your email' }, status: 200 })
  })

  it('forwards the signed-in visitor’s session, so the account-required setting can be met @S-374', async () => {
    // A stand-in for the CMS rule: with `alertsAllowWithoutAccount` off, no session means no alert.
    const accountOnly = clientWith({
      subscribe: vi.fn(async (input: { userToken?: string }) =>
        input.userToken === 'member-token'
          ? ok({ status: 'subscribed' as const })
          : refused('account_required', 403, 'Sign in to set up job alerts on this site.'),
      ),
    })
    const withSession = new Request('https://vanuatuwok.vu/alerts/subscribe', {
      body: new URLSearchParams({ email: 'ignored@example.com' }),
      headers: { cookie: 'theme=dark; mc_session=member-token; other=1' },
      method: 'POST',
    })

    expect(await subscribePage(accountOnly, withSession)).toMatchObject({
      notice: { title: 'Job alert saved' },
      status: 200,
    })
    expect(accountOnly.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userToken: 'member-token' }))

    // The same request without the cookie is refused, and says why.
    expect(await subscribePage(accountOnly, post('/alerts/subscribe', { email: 'a@b.co' }))).toMatchObject({
      notice: { kind: 'error', message: 'Sign in to set up job alerts on this site.' },
      status: 400,
    })
    expect(accountOnly.subscribe).toHaveBeenLastCalledWith(expect.objectContaining({ userToken: undefined }))
  })

  it('does not send any other cookie to the CMS as a session', async () => {
    const client = clientWith()
    await subscribePage(
      client,
      new Request('https://vanuatuwok.vu/alerts/subscribe', {
        body: new URLSearchParams({ email: 'a@b.co' }),
        headers: { cookie: 'impersonating=1; session=nope' },
        method: 'POST',
      }),
    )

    expect(client.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userToken: undefined }))
  })

  it('does not subscribe on a GET: the link in a search result just goes back to the listing', async () => {
    const client = clientWith()

    expect(await subscribePage(client, get('/alerts/subscribe'))).toEqual({ kind: 'redirect', location: '/jobs' })
    expect(client.subscribe).not.toHaveBeenCalled()
  })

  it('shows the CMS’s refusal with a matching status, and a rate limit as 429', async () => {
    const limited = clientWith({ subscribe: vi.fn(async () => refused('too_many_requests', 429, 'Slow down.')) })
    const page = await subscribePage(limited, post('/alerts/subscribe', { email: 'a@b.co' }))

    expect(page).toMatchObject({ notice: { kind: 'error', message: 'Slow down.' }, status: 429 })

    const down = clientWith({ subscribe: vi.fn(async () => refused('network', 0)) })
    expect(await subscribePage(down, post('/alerts/subscribe', { email: 'a@b.co' }))).toMatchObject({ status: 502 })
  })

  it('says alerts are unavailable, with 503, when the site has no CMS configured', async () => {
    for (const page of [
      await subscribePage(null, post('/alerts/subscribe', { email: 'a@b.co' })),
      await confirmPage(null, post('/alerts/confirm/a.b', { confirm: '1' }), 'a.b'),
      await managePage(null, get('/alerts/manage/a.b'), 'a.b'),
      await unsubscribePage(null, post('/alerts/unsubscribe/a.b', {}), 'a.b'),
    ]) {
      expect(page).toMatchObject({ kind: 'notice', status: 503 })
    }
  })

  it('confirm: opening the link changes nothing, so a link scanner cannot confirm a subscription', async () => {
    const client = clientWith({ confirm: vi.fn(async () => ok({ alert, manageToken: 'm.t' })) })

    expect(await confirmPage(client, get('/alerts/confirm/a.b'), 'a.b')).toEqual({
      kind: 'confirm-form',
      status: 200,
    })
    expect(client.confirm).not.toHaveBeenCalled()
  })

  it('confirm: only the button’s POST confirms, and says so in the subscriber’s words', async () => {
    const client = clientWith({ confirm: vi.fn(async () => ok({ alert, manageToken: 'm.t' })) })
    const page = await confirmPage(client, post('/alerts/confirm/a.b', { confirm: '1' }), 'a.b', {
      clientIp: '203.0.113.7',
    })

    expect(client.confirm).toHaveBeenCalledWith({ clientIp: '203.0.113.7', token: 'a.b' })
    expect(page).toMatchObject({ kind: 'notice', notice: { title: 'Job alert confirmed' }, status: 200 })
  })

  it('confirm: a stale link on the POST is an error page', async () => {
    expect(await confirmPage(clientWith(), post('/alerts/confirm/a.b', { confirm: '1' }), 'a.b')).toMatchObject({
      notice: { kind: 'error', title: 'This link is not valid' },
      status: 400,
    })
  })

  it('unsubscribe: a GET changes nothing, so a mail scanner cannot unsubscribe anyone', async () => {
    const client = clientWith()

    expect(await unsubscribePage(client, get('/alerts/unsubscribe/a.b'), 'a.b')).toEqual({
      kind: 'unsubscribe-form',
      status: 200,
    })
    expect(client.unsubscribe).not.toHaveBeenCalled()
  })

  it('unsubscribe: the button’s POST unsubscribes one alert and says the others are unaffected', async () => {
    const client = clientWith()
    const page = await unsubscribePage(client, post('/alerts/unsubscribe/a.b', { confirm: '1' }), 'a.b')

    expect(client.unsubscribe).toHaveBeenCalledWith({ clientIp: undefined, token: 'a.b' })
    expect(page).toMatchObject({ kind: 'notice', notice: { title: 'Unsubscribed' }, status: 200 })
  })

  it('unsubscribe: a mail client’s one-click POST (RFC 8058) gets a bare 200', async () => {
    const client = clientWith()
    const page = await unsubscribePage(
      client,
      post('/alerts/unsubscribe/a.b', { 'List-Unsubscribe': 'One-Click' }),
      'a.b',
    )

    expect(page).toEqual({ kind: 'one-click', status: 200 })
    expect(client.unsubscribe).toHaveBeenCalledOnce()

    const stale = clientWith({ unsubscribe: vi.fn(async () => refused('invalid_token')) })
    expect(
      await unsubscribePage(stale, post('/x', { 'List-Unsubscribe': 'One-Click' }), 'bad'),
    ).toEqual({ kind: 'one-click', status: 400 })
  })

  it('manage request: a GET shows the form; a POST asks for the link and answers the same for anyone', async () => {
    const client = clientWith()

    expect(await manageRequestPage(client, get('/alerts/manage'))).toEqual({ kind: 'manage-request', status: 200 })
    const page = await manageRequestPage(client, post('/alerts/manage', { email: 'jo@example.com' }))
    expect(client.requestManageLink).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jo@example.com' }),
    )
    expect(page).toMatchObject({ kind: 'notice', status: 200 })
  })

  it('manage request: a refusal keeps the form on screen so the visitor can try again', async () => {
    const client = clientWith({ requestManageLink: vi.fn(async () => refused('turnstile_failed')) })
    const page = await manageRequestPage(client, post('/alerts/manage', { email: 'a@b.co' }))

    expect(page).toMatchObject({ kind: 'manage-request', notice: { kind: 'error' }, status: 400 })
  })

  it('manage: lists the alerts, saves one and deletes another, each with a message', async () => {
    const client = clientWith({
      list: vi.fn(async () => ok({ alerts: [alert] })),
      update: vi.fn(async () => ok({ alert })),
    })

    expect(await managePage(client, get('/alerts/manage/t'), 't')).toEqual({
      alerts: [alert],
      kind: 'manage-list',
      message: undefined,
      status: 200,
    })

    const saved = await managePage(
      client,
      post('/alerts/manage/t', { action: 'save', frequency: 'weekly', id: '5' }),
      't',
    )
    expect(client.update).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, frequency: 'weekly', id: '5', token: 't' }),
    )
    expect(saved).toMatchObject({ kind: 'manage-list', message: 'Your changes were saved.' })

    const deleted = await managePage(client, post('/alerts/manage/t', { action: 'delete', id: '5' }), 't')
    expect(client.remove).toHaveBeenCalledWith(expect.objectContaining({ id: '5', token: 't' }))
    expect(deleted).toMatchObject({ message: 'The alert was deleted.' })
  })

  it('manage: a bad link, or someone else’s alert, is an error page and never a list', async () => {
    const bad = clientWith({ list: vi.fn(async () => refused('invalid_token')) })
    expect(await managePage(bad, get('/alerts/manage/x'), 'x')).toMatchObject({ kind: 'notice', status: 400 })

    const foreign = clientWith({ remove: vi.fn(async () => refused('alert_not_found', 404)) })
    const page = await managePage(foreign, post('/alerts/manage/t', { action: 'delete', id: '99' }), 't')
    expect(page).toMatchObject({ kind: 'notice', status: 404 })
    expect(foreign.list).not.toHaveBeenCalled()
  })
})
