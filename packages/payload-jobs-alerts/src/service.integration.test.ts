import type { CollectionConfig } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  locationsCollection,
  taxonomyCollections,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'

import type { AlertEmailDoc, AlertEmailEvent } from './email'
import { alertSettingsFields } from './settings'
import {
  alertManageURL,
  alertUnsubscribeHeaders,
  alertUnsubscribeURL,
  confirmAlert,
  listAlerts,
  removeAlert,
  requestManageLink,
  subscribeToAlert,
  unsubscribeAlert,
  updateAlert,
  type AlertsContext,
  type AlertTenant,
} from './service'
import { alertSubscriptionCollection, ALERT_SUBSCRIPTIONS_SLUG } from './subscriptions'
import { signAlertToken } from './tokens'

/**
 * The alert flow against a real database: subscribe, confirm, manage and unsubscribe, with two
 * tenants so tenant isolation is part of every behaviour.
 */

const SECRET = 'test-secret'

type Sent = { doc: AlertEmailDoc; event: AlertEmailEvent }

const taxonomies = (): CollectionConfig[] => [
  ...taxonomyCollections({ tenantScoped: true }),
  locationsCollection({ requireTenant: true }),
]

const tokenOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

describe('alert subscribe, confirm, manage and unsubscribe @S-085 @S-086 @S-087 @S-360 @S-361', () => {
  let harness: TestHarness
  let sent: Sent[]
  let failEmail = false
  let a: AlertsContext
  let b: AlertsContext
  let categoryA: { id: number | string }
  let categoryB: { id: number | string }

  const tenantDoc = async (id: number, settings: Record<string, unknown> = {}): Promise<AlertTenant> =>
    (await harness.payload.update({
      collection: 'tenants',
      data: settings as never,
      id,
      overrideAccess: true,
    })) as unknown as AlertTenant

  const contextFor = (tenant: AlertTenant, extra: Partial<AlertsContext> = {}): AlertsContext => ({
    alertsSlug: ALERT_SUBSCRIPTIONS_SLUG,
    payload: harness.payload,
    secret: SECRET,
    sendEmail: (event, doc) => {
      if (failEmail) throw new Error('smtp down')
      sent.push({ doc, event })
    },
    tenant,
    ...extra,
  })

  const reload = async (context: AlertsContext, settings: Record<string, unknown>) =>
    contextFor(await tenantDoc(Number(context.tenant.id), settings))

  const count = async (where: Record<string, unknown> = {}) =>
    (
      await harness.payload.count({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        overrideAccess: true,
        where: where as never,
      })
    ).totalDocs

  const category = async (tenant: number, slug: string, name = slug) =>
    harness.payload.create({
      collection: 'job-categories',
      data: { name, slug, tenant } as never,
      overrideAccess: true,
    })

  beforeEach(async () => {
    sent = []
    failEmail = false
    harness = await bootTestPayload({
      collections: [alertSubscriptionCollection(), ...taxonomies()],
      tenantData: (which) => ({ domains: [{ domain: `${which.toLowerCase()}.example.test` }], name: `Site ${which}` }),
      tenantFields: [
        { name: 'domains', type: 'array', fields: [{ name: 'domain', type: 'text' }] },
        { name: 'addOns', type: 'json' },
        ...alertSettingsFields(),
      ],
    })
    a = contextFor((await tenantDoc(harness.tenantA.id)) as AlertTenant)
    b = contextFor((await tenantDoc(harness.tenantB.id)) as AlertTenant)
    categoryA = await category(harness.tenantA.id, 'hospitality', 'Hospitality')
    categoryB = await category(harness.tenantB.id, 'hospitality', 'Hospitality')
    await category(harness.tenantA.id, 'nursing', 'Nursing')
  })

  afterEach(async () => {
    if (harness) await harness.destroy()
  })

  describe('subscribe', () => {
    it('stores the saved search unconfirmed and emails a signed confirmation link', async () => {
      const result = await subscribeToAlert(a, {
        email: ' Jo@Example.COM ',
        filters: { category: 'Hospitality', q: ' hotel   cook ' },
      })

      expect(result).toEqual({ status: 'pending' })

      const { docs } = await harness.payload.find({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        depth: 0,
        overrideAccess: true,
      })
      expect(docs).toHaveLength(1)
      expect(docs[0]).toMatchObject({
        active: true,
        confirmed: false,
        email: 'jo@example.com',
        frequency: 'daily',
        keywords: 'hotel cook',
        tenant: harness.tenantA.id,
      })
      expect(docs[0]!.categories).toEqual([categoryA.id])

      expect(sent).toHaveLength(1)
      expect(sent[0]!.event).toBe('alert-confirm')
      expect(sent[0]!.doc).toMatchObject({ email: 'jo@example.com', tenant: harness.tenantA.id })
      expect(sent[0]!.doc.variables).toMatchObject({
        alertSummary: '“hotel cook” · Hospitality',
        frequency: 'daily',
        siteName: 'Site A',
      })
      expect(sent[0]!.doc.variables.confirmUrl).toMatch(
        /^https:\/\/a\.example\.test\/alerts\/confirm\/[\w-]+\.[\w-]+$/,
      )
    })

    it('keeps the alert unconfirmed until the link is opened', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'nurse' } })
      expect(await count({ confirmed: { equals: true } })).toBe(0)

      const { alert } = await confirmAlert(a, tokenOf(sent[0]!.doc.variables.confirmUrl!))
      expect(alert).toMatchObject({ confirmed: true, frequency: 'daily', summary: '“nurse”' })
      expect(await count({ confirmed: { equals: true } })).toBe(1)
    })

    it('takes weekly, and refuses any other frequency', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', frequency: 'weekly' })
      expect(
        (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs[0],
      ).toMatchObject({ frequency: 'weekly' })

      await expect(
        subscribeToAlert(a, { email: 'x@example.com', frequency: 'hourly' }),
      ).rejects.toMatchObject({ code: 'invalid_frequency' })
    })

    it('makes no second row for the same email and search, however it is typed @S-085', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { category: 'hospitality', q: 'Cook' } })
      await subscribeToAlert(a, { email: 'JO@example.com', filters: { q: ' cook ', category: 'HOSPITALITY' } })

      expect(await count()).toBe(1)
      // The second request re-sends the confirmation, so a lost email can be asked for again.
      expect(sent.map((email) => email.event)).toEqual(['alert-confirm', 'alert-confirm'])
    })

    it('points an already confirmed duplicate at the manage page instead of making a copy', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'cook' } })
      await confirmAlert(a, tokenOf(sent[0]!.doc.variables.confirmUrl!))
      sent = []

      expect(await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'cook' } })).toEqual({
        status: 'pending',
      })
      expect(await count()).toBe(1)
      expect(sent.map((email) => email.event)).toEqual(['alert-manage-link'])
    })

    it('allows several different alerts for one address @S-086', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'cook' } })
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { category: 'nursing' } })
      await subscribeToAlert(a, { email: 'jo@example.com' })

      expect(await count({ email: { equals: 'jo@example.com' } })).toBe(3)
    })

    it('caps the alerts per address at the tenant setting @S-364', async () => {
      const capped = await reload(a, { alertsMaxPerEmail: 2 })
      await subscribeToAlert(capped, { email: 'jo@example.com', filters: { q: 'one' } })
      await subscribeToAlert(capped, { email: 'jo@example.com', filters: { q: 'two' } })

      await expect(
        subscribeToAlert(capped, { email: 'jo@example.com', filters: { q: 'three' } }),
      ).rejects.toMatchObject({ code: 'too_many_alerts', status: 400 })
      // The same search is a duplicate, not a third alert, so it is still answered.
      await expect(
        subscribeToAlert(capped, { email: 'jo@example.com', filters: { q: 'two' } }),
      ).resolves.toEqual({ status: 'pending' })
      // Another address is unaffected.
      await expect(subscribeToAlert(capped, { email: 'al@example.com' })).resolves.toBeDefined()
    })

    it('treats the same address on two sites as two subscribers', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com' })
      await subscribeToAlert(b, { email: 'jo@example.com' })

      expect(await count({ tenant: { equals: harness.tenantA.id } })).toBe(1)
      expect(await count({ tenant: { equals: harness.tenantB.id } })).toBe(1)
      expect(sent[1]!.doc.variables.confirmUrl).toMatch(/^https:\/\/b\.example\.test\//)
    })

    it('refuses another site’s category as an unknown filter', async () => {
      // `nursing` exists on A only; B has no such category.
      await expect(
        subscribeToAlert(b, { email: 'jo@example.com', filters: { category: 'nursing' } }),
      ).rejects.toMatchObject({ code: 'invalid_filter' })
      await expect(
        subscribeToAlert(a, { email: 'jo@example.com', filters: { location: 'nowhere' } }),
      ).rejects.toMatchObject({ code: 'invalid_filter' })
      expect(await count()).toBe(0)

      // The category with the same slug on B resolves to B's own row, never A's.
      await subscribeToAlert(b, { email: 'jo@example.com', filters: { category: 'hospitality' } })
      const { docs } = await harness.payload.find({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        depth: 0,
        overrideAccess: true,
      })
      expect(docs[0]!.categories).toEqual([categoryB.id])
    })

    it('refuses bad and disposable addresses before anything is stored or sent', async () => {
      for (const email of ['', 'not-an-email', undefined, 42]) {
        await expect(subscribeToAlert(a, { email })).rejects.toMatchObject({ code: 'invalid_email' })
      }
      await expect(subscribeToAlert(a, { email: 'x@mailinator.com' })).rejects.toMatchObject({
        code: 'disposable_email',
      })
      await expect(
        subscribeToAlert({ ...a, blockedEmailDomains: ['blocked.test'] }, { email: 'x@blocked.test' }),
      ).rejects.toMatchObject({ code: 'disposable_email' })

      expect(await count()).toBe(0)
      expect(sent).toHaveLength(0)
    })

    it('starts the alert at once, with no email, when double opt-in is off @S-364', async () => {
      const open = await reload(a, { alertsDoubleOptIn: false })

      expect(await subscribeToAlert(open, { email: 'jo@example.com' })).toEqual({ status: 'subscribed' })
      expect(await count({ confirmed: { equals: true } })).toBe(1)
      expect(sent).toHaveLength(0)
    })

    it('needs a signed-in account when the tenant turns anonymous alerts off @S-364', async () => {
      const closed = await reload(a, { alertsAllowWithoutAccount: false })

      await expect(subscribeToAlert(closed, { email: 'jo@example.com' })).rejects.toMatchObject({
        code: 'account_required',
        status: 403,
      })
      expect(await count()).toBe(0)

      // The address comes from the account, not from the form, and is already verified.
      await expect(
        subscribeToAlert(closed, { email: 'someone-else@example.com', user: { email: 'Me@Example.com' } }),
      ).resolves.toEqual({ status: 'subscribed' })
      expect(
        (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs[0],
      ).toMatchObject({ confirmed: true, email: 'me@example.com' })
      expect(sent).toHaveLength(0)
    })

    it('does not skip the confirmation for a signed-in user subscribing another address', async () => {
      await subscribeToAlert(a, { email: 'friend@example.com', user: { email: 'me@example.com' } })

      expect(await count({ confirmed: { equals: true } })).toBe(0)
      expect(sent.map((email) => email.event)).toEqual(['alert-confirm'])
    })

    it('is off for a tenant that switched the add-on off', async () => {
      const off = await reload(a, { addOns: ['reports'] })

      await expect(subscribeToAlert(off, { email: 'jo@example.com' })).rejects.toMatchObject({
        code: 'alerts_disabled',
        status: 404,
      })
      await expect(unsubscribeAlert(off, 'x.y')).rejects.toMatchObject({ code: 'alerts_disabled' })
    })

    it('fails clearly, not silently, when email is down or the site has no domain', async () => {
      failEmail = true
      await expect(subscribeToAlert(a, { email: 'jo@example.com' })).rejects.toMatchObject({
        code: 'email_not_configured',
      })

      const bare = await reload(a, { domains: [] })
      await expect(subscribeToAlert(bare, { email: 'al@example.com' })).rejects.toMatchObject({
        code: 'tenant_not_configured',
      })
    })
  })

  describe('confirm', () => {
    const confirmURL = async (email = 'jo@example.com') => {
      await subscribeToAlert(a, { email, filters: { q: 'cook' } })
      return tokenOf(sent.at(-1)!.doc.variables.confirmUrl!)
    }

    it('is idempotent and hands back a manage token for the address', async () => {
      const token = await confirmURL()
      const first = await confirmAlert(a, token)
      const second = await confirmAlert(a, token)

      expect(second.alert).toEqual(first.alert)
      expect(await listAlerts(a, first.manageToken)).toHaveLength(1)
    })

    it('refuses another site’s link, a manage link, an unsubscribe link and rubbish', async () => {
      const token = await confirmURL()
      const id = String(
        (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs[0]!.id,
      )

      for (const bad of [
        token, // used on site B below
        await signAlertToken({ purpose: 'unsubscribe', secret: SECRET, subject: id, tenant: harness.tenantA.id }),
        await signAlertToken({ purpose: 'manage', secret: SECRET, subject: id, tenant: harness.tenantA.id }),
        'rubbish',
        undefined,
      ]) {
        const target = bad === token ? b : a
        await expect(confirmAlert(target, bad)).rejects.toMatchObject({ code: 'invalid_token' })
      }
      expect(await count({ confirmed: { equals: true } })).toBe(0)
    })

    it('refuses an expired link', async () => {
      const token = await confirmURL()
      const later = { ...a, now: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000) }

      await expect(confirmAlert(later, token)).rejects.toMatchObject({ code: 'invalid_token' })
    })

    it('refuses a link whose alert was deleted, even if an id is reused for nothing', async () => {
      const token = await confirmURL()
      await harness.payload.delete({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true, where: {} })

      await expect(confirmAlert(a, token)).rejects.toMatchObject({ code: 'invalid_token' })
    })
  })

  describe('manage', () => {
    const manageToken = async (context = a, email = 'jo@example.com') =>
      tokenOf(await alertManageURL(context, email))

    beforeEach(async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'cook' } })
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { category: 'nursing' } })
      await subscribeToAlert(a, { email: 'al@example.com', filters: { q: 'driver' } })
      await subscribeToAlert(b, { email: 'jo@example.com', filters: { q: 'other site' } })
    })

    it('lists this address’s alerts on this site and nobody else’s', async () => {
      const alerts = await listAlerts(a, await manageToken())

      expect(alerts.map((alert) => alert.summary).sort()).toEqual(['Nursing', '“cook”'])
      expect(JSON.stringify(alerts)).not.toContain('@')
      // The same address on site B is a different list, reached by B's own link only.
      expect((await listAlerts(b, await manageToken(b))).map((alert) => alert.summary)).toEqual([
        '“other site”',
      ])
      await expect(listAlerts(b, await manageToken(a))).rejects.toMatchObject({ code: 'invalid_token' })
    })

    it('changes one alert and pauses another, independently @S-086', async () => {
      const token = await manageToken()
      const [first, second] = await listAlerts(a, token)

      await updateAlert(a, token, first!.id, { frequency: 'weekly' })
      await updateAlert(a, token, second!.id, { active: false })

      const after = await listAlerts(a, token)
      expect(after.find((alert) => alert.id === first!.id)).toMatchObject({ active: true, frequency: 'weekly' })
      expect(after.find((alert) => alert.id === second!.id)).toMatchObject({ active: false, frequency: 'daily' })
    })

    it('refuses to change, pause or delete an alert that is not the address’s', async () => {
      const token = await manageToken()
      const others = (
        await harness.payload.find({
          collection: ALERT_SUBSCRIPTIONS_SLUG,
          overrideAccess: true,
          where: { email: { not_equals: 'jo@example.com' } },
        })
      ).docs

      for (const other of others) {
        await expect(updateAlert(a, token, other.id, { active: false })).rejects.toMatchObject({
          code: 'alert_not_found',
        })
        await expect(removeAlert(a, token, other.id)).rejects.toMatchObject({ code: 'alert_not_found' })
      }
      expect(await count()).toBe(4)
      expect(await count({ active: { equals: false } })).toBe(0)
    })

    it('refuses a bad frequency, and ids that are not ids', async () => {
      const token = await manageToken()
      const [first] = await listAlerts(a, token)

      await expect(updateAlert(a, token, first!.id, { frequency: 'monthly' })).rejects.toMatchObject({
        code: 'invalid_frequency',
      })
      await expect(updateAlert(a, token, { $ne: 0 }, { active: false })).rejects.toMatchObject({
        code: 'alert_not_found',
      })
    })

    it('deletes one alert and keeps the rest', async () => {
      const token = await manageToken()
      const [first] = await listAlerts(a, token)

      await removeAlert(a, token, first!.id)

      expect(await listAlerts(a, token)).toHaveLength(1)
      expect(await count()).toBe(3)
    })

    it('sends a new manage link only to an address with a confirmed alert, and answers the same', async () => {
      sent = []
      await requestManageLink(a, 'nobody@example.com')
      await requestManageLink(a, 'jo@example.com') // has alerts, none confirmed yet
      expect(sent).toHaveLength(0)

      await confirmAlert(a, tokenOf(await alertConfirmLink('jo@example.com')))
      sent = []
      await requestManageLink(a, 'jo@example.com')

      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ event: 'alert-manage-link', doc: { email: 'jo@example.com' } })
      expect(sent[0]!.doc.variables.manageUrl).toMatch(/^https:\/\/a\.example\.test\/alerts\/manage\//)
      await expect(requestManageLink(a, 'bad')).rejects.toMatchObject({ code: 'invalid_email' })
    })

    const alertConfirmLink = async (email: string): Promise<string> => {
      sent = []
      await subscribeToAlert(a, { email, filters: { q: 'cook' } })
      return sent.find((entry) => entry.event === 'alert-confirm')!.doc.variables.confirmUrl!
    }
  })

  describe('unsubscribe', () => {
    it('removes only the alert in the link, with one click @S-087', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'cook' } })
      await subscribeToAlert(a, { email: 'jo@example.com', filters: { q: 'driver' } })
      const alerts = (
        await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true, sort: 'id' })
      ).docs
      const link = tokenOf(await alertUnsubscribeURL(a, alerts[0]!.id))

      expect(await unsubscribeAlert(a, link)).toEqual({ already: false })
      expect(await count()).toBe(1)
      expect(
        (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs[0]!.id,
      ).toBe(alerts[1]!.id)
    })

    it('can be followed twice, and still works long after sending', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com' })
      const [alert] = (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs
      const link = tokenOf(await alertUnsubscribeURL(a, alert!.id))
      const longAfter = { ...a, now: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000) }

      expect(await unsubscribeAlert(longAfter, link)).toEqual({ already: false })
      expect(await unsubscribeAlert(longAfter, link)).toEqual({ already: true })
    })

    it('does nothing on another site, and refuses other kinds of link', async () => {
      await subscribeToAlert(a, { email: 'jo@example.com' })
      await subscribeToAlert(b, { email: 'jo@example.com' })
      const [alert] = (
        await harness.payload.find({
          collection: ALERT_SUBSCRIPTIONS_SLUG,
          overrideAccess: true,
          where: { tenant: { equals: harness.tenantA.id } },
        })
      ).docs
      const link = tokenOf(await alertUnsubscribeURL(a, alert!.id))

      await expect(unsubscribeAlert(b, link)).rejects.toMatchObject({ code: 'invalid_token' })
      await expect(unsubscribeAlert(a, tokenOf(sent[0]!.doc.variables.confirmUrl!))).rejects.toMatchObject({
        code: 'invalid_token',
      })
      await expect(unsubscribeAlert(a, 'x')).rejects.toMatchObject({ code: 'invalid_token' })
      expect(await count()).toBe(2)
    })

    it('does not delete another site’s alert even if a link names its id', async () => {
      await subscribeToAlert(b, { email: 'jo@example.com' })
      const [other] = (await harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, overrideAccess: true })).docs
      // A link signed for A, carrying B's alert id.
      const forged = tokenOf(await alertUnsubscribeURL(a, other!.id))

      expect(await unsubscribeAlert(a, forged)).toEqual({ already: true })
      expect(await count()).toBe(1)
    })

    it('exposes the RFC 8058 headers for the digest', async () => {
      const url = await alertUnsubscribeURL(a, 7)

      expect(url).toMatch(/^https:\/\/a\.example\.test\/alerts\/unsubscribe\//)
      expect(alertUnsubscribeHeaders(url)).toEqual({
        'List-Unsubscribe': `<${url}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      })
    })
  })

})
