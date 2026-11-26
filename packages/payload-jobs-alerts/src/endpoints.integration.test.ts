import type { CollectionConfig, PayloadRequest } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMemoryRateLimiter,
  generateSiteKey,
  locationsCollection,
  taxonomyCollections,
  type RateLimiter,
  type TurnstileVerifier,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'

import type { AlertEmailDoc, AlertEmailEvent } from './email'
import { alertEndpoints, ALERT_HONEYPOT_FIELD, type AlertEndpointsOptions } from './endpoints'
import { alertSettingsFields } from './settings'
import { alertSubscriptionCollection, ALERT_SUBSCRIPTIONS_SLUG } from './subscriptions'

/**
 * The HTTP edge of the alert flow: site key and tenant, bot checks and rate limits. The flow
 * itself is covered in service.integration.test.ts; here the handlers run with a real database
 * and a stand-in for the request.
 */

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: () => true, read: () => true },
  fields: [
    { name: 'label', type: 'text' },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

type Sent = { doc: AlertEmailDoc; event: AlertEmailEvent }
type Reply = { body: Record<string, any>; headers: Headers; status: number }

const fresh = (): AlertEndpointsOptions => ({
  emailRateLimiter: createMemoryRateLimiter({ limit: 1000, windowMs: 3_600_000 }),
  rateLimiter: createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 }),
})

describe('alert endpoints @S-085 @S-086 @S-087 @S-372', () => {
  let harness: TestHarness
  let sent: Sent[]
  let verified: string[]
  let keyA: string
  let keyB: string
  let options: AlertEndpointsOptions

  const verifier: TurnstileVerifier = async ({ token }) => {
    verified.push(token)
    return { success: token === 'good' }
  }

  const call = async (
    path: string,
    body: unknown,
    { key = keyA, slug = harness.tenantA.slug, ip = '203.0.113.5', user = null }: {
      ip?: string
      key?: null | string
      slug?: string
      user?: unknown
    } = {},
  ): Promise<Reply> => {
    const endpoint = alertEndpoints({
      alertsSlug: ALERT_SUBSCRIPTIONS_SLUG,
      sendEmail: (event, doc) => {
        sent.push({ doc, event })
      },
      turnstile: { secret: () => 'turnstile-secret', verify: verifier },
      ...options,
    }).find((candidate) => candidate.path === `/:slug/alerts/${path}`)!

    const headers = new Headers({ 'x-end-user-ip': ip })
    if (key) headers.set('x-site-key', key)

    const response = (await endpoint.handler({
      context: {},
      headers,
      payload: harness.payload,
      routeParams: { slug },
      text: async () => JSON.stringify(body),
      user,
    } as unknown as PayloadRequest)) as Response

    return { body: (await response.json()) as Reply['body'], headers: response.headers, status: response.status }
  }

  const stored = async () =>
    (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, depth: 0, overrideAccess: true })).docs

  const subscribe = (extra: Record<string, unknown> = {}, init = {}) =>
    call('subscribe', { email: 'jo@example.com', turnstileToken: 'good', ...extra }, init)

  beforeEach(async () => {
    sent = []
    verified = []
    // Every boot reuses tenant ids 1 and 2, so a limiter shared across tests would carry over.
    options = fresh()
    harness = await bootTestPayload({
      collections: [
        alertSubscriptionCollection(),
        ...taxonomyCollections({ tenantScoped: true }),
        locationsCollection({ requireTenant: true }),
      ],
      globalCollections: [SiteKeys],
      tenantData: (which) => ({ domains: [{ domain: `${which.toLowerCase()}.example.test` }] }),
      tenantFields: [
        { name: 'domains', type: 'array', fields: [{ name: 'domain', type: 'text' }] },
        { name: 'addOns', type: 'json' },
        ...alertSettingsFields(),
      ],
    })

    const make = async (tenant: number) => {
      const { key, keyHash } = await generateSiteKey()
      await harness.payload.create({
        collection: 'site-keys',
        data: { keyHash, tenant } as never,
        overrideAccess: true,
      })
      return key
    }
    keyA = await make(harness.tenantA.id)
    keyB = await make(harness.tenantB.id)
  })

  afterEach(async () => {
    if (harness) await harness.destroy()
  })

  it('needs a site key that belongs to the tenant in the path', async () => {
    expect((await subscribe({}, { key: null })).status).toBe(401)
    expect((await subscribe({}, { key: 'sk_unknown' })).status).toBe(401)
    // Site B's key on site A's URL.
    expect((await subscribe({}, { key: keyB })).status).toBe(403)
    expect((await subscribe({}, { slug: 'no-such-site' })).status).toBe(404)
    expect(await stored()).toHaveLength(0)
    expect(sent).toHaveLength(0)
  })

  it('subscribes, and the tenant comes from the key, never from the body', async () => {
    const reply = await subscribe({ tenant: harness.tenantB.id, filters: { q: 'cook' } })

    expect(reply).toMatchObject({ body: { ok: true, status: 'pending' }, status: 200 })
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect((await stored())[0]).toMatchObject({ tenant: harness.tenantA.id, keywords: 'cook' })
    expect(sent.map((email) => email.event)).toEqual(['alert-confirm'])
  })

  it('answers a bot like a person, and stores and sends nothing', async () => {
    const reply = await subscribe({ [ALERT_HONEYPOT_FIELD]: 'http://spam.example' })

    expect(reply).toMatchObject({ body: { ok: true, status: 'pending' }, status: 202 })
    expect(await stored()).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(verified).toHaveLength(0)
  })

  it('checks Turnstile before anything is written, and fails closed without a secret', async () => {
    expect((await call('subscribe', { email: 'jo@example.com' })).body.error.code).toBe('turnstile_failed')
    expect((await subscribe({ turnstileToken: 'forged' })).body.error.code).toBe('turnstile_failed')
    expect(verified).toEqual(['forged'])
    expect(await stored()).toHaveLength(0)

    options = { ...fresh(), turnstile: { secret: () => undefined, verify: verifier } }
    const reply = await subscribe()
    expect(reply.status).toBe(500)
    expect(reply.body.error.code).toBe('turnstile_not_configured')
    expect(await stored()).toHaveLength(0)
  })

  it('rate limits a visitor, answering 429 with retry-after', async () => {
    options = { ...fresh(), rateLimiter: createMemoryRateLimiter({ limit: 2, windowMs: 60_000 }) }

    expect((await subscribe({ email: 'a@example.com' })).status).toBe(200)
    expect((await subscribe({ email: 'b@example.com' })).status).toBe(200)
    const limited = await subscribe({ email: 'c@example.com' })

    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect(await stored()).toHaveLength(2)
  })

  it('rate limits one address across visitors, so IPs cannot be rotated to mail-bomb it', async () => {
    const limiter: RateLimiter = createMemoryRateLimiter({ limit: 2, windowMs: 3_600_000 })
    options = { ...fresh(), emailRateLimiter: limiter }

    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      expect((await subscribe({}, { ip })).status).toBe(200)
    }
    const third = await subscribe({}, { ip: '198.51.100.3' })

    expect(third.status).toBe(429)
    expect(third.body.error.code).toBe('too_many_requests')
    expect(sent).toHaveLength(2)
    // Another address is untouched, and so is the same address on another site.
    expect((await subscribe({ email: 'al@example.com' }, { ip: '198.51.100.3' })).status).toBe(200)
    expect((await subscribe({}, { ip: '198.51.100.3', key: keyB, slug: harness.tenantB.slug })).status).toBe(200)
  })

  it('limits one address across isolates through the shared store, not memory @S-372', async () => {
    // A fresh memory limiter per request stands for another isolate; the KV store is shared.
    options = { rateLimiter: createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 }) }
    const results = []
    for (let index = 0; index < 5; index += 1) results.push((await subscribe({}, { ip: `198.51.100.${index}` })).status)

    expect(results).toEqual([200, 200, 200, 429, 429])
    expect(sent).toHaveLength(3)

    // Other addresses are untouched, and so is the same address on another site.
    expect((await subscribe({ email: 'al@example.com' })).status).toBe(200)
    expect((await subscribe({}, { key: keyB, slug: harness.tenantB.slug })).status).toBe(200)
  })

  it('does not rate limit the address when the request is refused for another reason', async () => {
    const limiter = createMemoryRateLimiter({ limit: 1, windowMs: 3_600_000 })
    options = { ...fresh(), emailRateLimiter: limiter }

    expect((await subscribe({ turnstileToken: 'forged' })).status).toBe(400)
    expect((await subscribe()).status).toBe(200)
  })

  it('answers a capped address exactly like any other, so the form reveals nothing about it @S-372', async () => {
    await harness.payload.update({
      collection: 'tenants',
      data: { alertsMaxPerEmail: 1 } as never,
      id: harness.tenantA.id,
      overrideAccess: true,
    })
    await subscribe({ email: 'full@example.com', filters: { q: 'one' } })
    const confirmURL = sent[0]!.doc.variables.confirmUrl!
    await call('confirm', { token: confirmURL.slice(confirmURL.lastIndexOf('/') + 1) })

    const capped = await subscribe({ email: 'full@example.com', filters: { q: 'two' } })
    const ordinary = await subscribe({ email: 'fresh@example.com', filters: { q: 'two' } })

    expect(capped.status).toBe(ordinary.status)
    expect(capped.body).toEqual(ordinary.body)
    expect(capped.headers.get('retry-after')).toBe(ordinary.headers.get('retry-after'))
  })

  it('requires an account when the tenant says so, taking the address from it', async () => {
    await harness.payload.update({
      collection: 'tenants',
      data: { alertsAllowWithoutAccount: false } as never,
      id: harness.tenantA.id,
      overrideAccess: true,
    })

    expect((await subscribe()).body.error.code).toBe('account_required')

    const member = {
      email: 'Member@Example.com',
      id: 1,
      tenants: [{ role: 'seeker', tenant: harness.tenantA.id }],
    }
    expect((await subscribe({ email: 'ignored@example.com' }, { user: member })).body).toEqual({
      ok: true,
      status: 'subscribed',
    })
    expect((await stored())[0]).toMatchObject({ confirmed: true, email: 'member@example.com' })

    // A member of another site is not signed in here.
    const outsider = { ...member, tenants: [{ role: 'seeker', tenant: harness.tenantB.id }] }
    expect((await subscribe({}, { user: outsider })).body.error.code).toBe('account_required')
  })

  it('serves confirm, manage, update, remove and unsubscribe from the emailed links', async () => {
    await subscribe({ filters: { q: 'cook' } })
    await subscribe({ filters: { q: 'driver' } })
    const confirmURL = sent[0]!.doc.variables.confirmUrl!
    const confirm = await call('confirm', { token: confirmURL.slice(confirmURL.lastIndexOf('/') + 1) })

    expect(confirm.body).toMatchObject({ ok: true, alert: { confirmed: true, summary: '“cook”' } })
    expect(JSON.stringify(confirm.body)).not.toContain('jo@example.com')

    const token = confirm.body.manageToken as string
    const list = await call('manage', { token })
    expect(list.body.alerts.map((alert: { summary: string }) => alert.summary)).toEqual(['“cook”', '“driver”'])

    const [first, second] = list.body.alerts as { id: number }[]
    expect((await call('manage/update', { active: false, frequency: 'weekly', id: first!.id, token })).body.alert).toMatchObject({
      active: false,
      frequency: 'weekly',
    })
    expect((await call('manage/remove', { id: second!.id, token })).body).toEqual({ ok: true })
    expect(await stored()).toHaveLength(1)

    // The unsubscribe link only needs its own signature; no site key challenge, no JSON needed beyond it.
    const { alertUnsubscribeURL } = await import('./service')
    const tenant = (await harness.payload.findByID({ collection: 'tenants', id: harness.tenantA.id, overrideAccess: true })) as never
    const unsubscribe = await alertUnsubscribeURL({ secret: harness.payload.secret, tenant }, first!.id)
    const done = await call('unsubscribe', { token: unsubscribe.slice(unsubscribe.lastIndexOf('/') + 1) })

    expect(done.body).toEqual({ already: false, ok: true })
    expect(await stored()).toHaveLength(0)
  })

  it('answers a bad link with 400 and no detail, and bad JSON with 400', async () => {
    expect(await call('confirm', { token: 'nope' })).toMatchObject({
      body: { error: { code: 'invalid_token' } },
      status: 400,
    })
    expect((await call('manage', {})).body.error.code).toBe('invalid_token')
    expect((await call('unsubscribe', { token: 42 })).body.error.code).toBe('invalid_token')

    const endpoint = alertEndpoints().find((candidate) => candidate.path.endsWith('/confirm'))!
    const response = (await endpoint.handler({
      context: {},
      headers: new Headers({ 'x-site-key': keyA }),
      payload: harness.payload,
      routeParams: { slug: harness.tenantA.slug },
      text: async () => '{not json',
    } as unknown as PayloadRequest)) as Response
    expect(response.status).toBe(400)
  })

  it('sends a fresh manage link only through the protected form, with the same answer for anyone', async () => {
    await subscribe()
    const confirmURL = sent[0]!.doc.variables.confirmUrl!
    await call('confirm', { token: confirmURL.slice(confirmURL.lastIndexOf('/') + 1) })
    sent = []

    const known = await call('manage-link', { email: 'jo@example.com', turnstileToken: 'good' })
    const unknown = await call('manage-link', { email: 'nobody@example.com', turnstileToken: 'good' })
    expect(known.body).toEqual(unknown.body)
    expect(sent.map((email) => email.event)).toEqual(['alert-manage-link'])

    expect((await call('manage-link', { email: 'jo@example.com' })).body.error.code).toBe('turnstile_failed')
  })

  it('is closed for a tenant that switched the add-on off', async () => {
    await harness.payload.update({
      collection: 'tenants',
      data: { addOns: ['reports'] } as never,
      id: harness.tenantA.id,
      overrideAccess: true,
    })

    expect(await subscribe()).toMatchObject({ body: { error: { code: 'alerts_disabled' } }, status: 404 })
    expect((await call('unsubscribe', { token: 'x.y' })).status).toBe(404)
  })

  it('says email is not set up, instead of dropping the confirmation, when no sender is wired', async () => {
    const endpoint = alertEndpoints({ ...fresh(), turnstile: { enabled: false } }).find((candidate) =>
      candidate.path.endsWith('/subscribe'),
    )!
    const response = (await endpoint.handler({
      context: {},
      headers: new Headers({ 'x-site-key': keyA }),
      payload: harness.payload,
      routeParams: { slug: harness.tenantA.slug },
      text: async () => JSON.stringify({ email: 'jo@example.com' }),
    } as unknown as PayloadRequest)) as Response

    expect(response.status).toBe(503)
    expect(((await response.json()) as Reply['body']).error.code).toBe('email_not_configured')
  })
})
