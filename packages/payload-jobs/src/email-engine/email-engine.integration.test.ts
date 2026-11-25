import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bootTestPayload, type TestHarness } from '../test'
import { createEmailEventRegistry, type EmailTemplateEvent } from './events'
import { emailLogCollection } from './log'
import { applyEmailLogRetention, emailVolumeByMonth, monthlyEmailVolume } from './log-jobs'
import { logRetention } from './log-policy'
import { sendTemplateWith, type EmailEngineContext, type OutgoingMessage } from './send'
import { tenantEmailFields } from './settings'
import { emailTemplatesCollection } from './templates'

/**
 * The email engine against a real Postgres: template lookup per tenant, the per-tenant switch,
 * the non-production redirect, the log, retention and monthly volume.
 */

const databaseUrl = process.env.TEST_DATABASE_URL

const events = createEmailEventRegistry([
  {
    blocks: [{ key: 'jobList', label: 'Job list', render: () => ({ html: '<ul><li>Cook</li></ul>', text: '- Cook' }) }],
    defaultBody: [['Hello ', { variable: 'firstName' }]],
    defaultSubject: 'Default for {{firstName}}',
    label: 'Alert digest',
    recipient: (doc) => doc.email as string,
    slug: 'digest',
    variables: [{ key: 'firstName', label: 'First name', resolve: (doc) => doc.firstName as string }],
  } satisfies EmailTemplateEvent,
])

const chipBody = (key: string) => ({
  root: {
    type: 'root',
    children: [
      {
        type: 'paragraph',
        children: [
          { type: 'text', format: 0, text: 'Kia ora ', version: 1 },
          { type: 'inlineBlock', fields: { blockType: 'variable', key }, version: 1 },
        ],
        version: 1,
      },
    ],
    version: 1,
  },
})

describe.skipIf(!databaseUrl)('email engine @S-182', () => {
  let harness: TestHarness
  let payload: Payload
  let sent: OutgoingMessage[]
  let failWith: Error | null
  let redirect: EngineRedirect
  type EngineRedirect = EmailEngineContext['redirect']

  const ctx = (): EmailEngineContext => ({
    events,
    logSlug: 'email-log',
    payload,
    redirect: () => (redirect ? redirect() : undefined),
    sendEmail: async (message) => {
      if (failWith) throw failWith
      sent.push(message)
    },
    settingsSlug: 'job-board-settings',
    templatesSlug: 'email-templates',
    tenancy: 'multi',
    tenantsSlug: 'tenants',
  })

  const rows = async (tenant: number | string) =>
    (await payload.find({ collection: 'email-log' as never, depth: 0, overrideAccess: true, pagination: false, where: { tenant: { equals: tenant } } }))
      .docs as unknown as Record<string, unknown>[]

  const template = (tenant: number, data: Record<string, unknown>) =>
    payload.create({
      collection: 'email-templates' as never,
      data: { event: 'digest', tenant, ...data } as never,
      overrideAccess: true,
    })

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [emailTemplatesCollection({ events }), emailLogCollection()],
      tenantData: (which) => ({
        emailBranding: { brandColour: which === 'A' ? '#0a6e3f' : '#7a1f1f', logoUrl: 'https://cdn.example.test/logo.png' },
        emailFromAddress: `hello-${which.toLowerCase()}@example.test`,
        emailFromName: `Site ${which}`,
      }),
      tenantFields: [
        { name: 'emailFromAddress', type: 'email' },
        { name: 'emailFromName', type: 'text' },
        ...tenantEmailFields(),
      ],
    })
    payload = harness.payload
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  beforeEach(async () => {
    sent = []
    failWith = null
    redirect = undefined
    await payload.delete({ collection: 'email-log' as never, overrideAccess: true, where: { id: { exists: true } } })
    await payload.delete({ collection: 'email-templates' as never, overrideAccess: true, where: { id: { exists: true } } })
  })

  it('renders the tenant’s own template, sends from the tenant and logs without any text @S-183 @S-186', async () => {
    const { tenantA } = harness
    const created = (await template(tenantA.id, { body: chipBody('firstName'), subject: 'Hi {{firstName}}' })) as { id: number }

    const result = await sendTemplateWith(ctx(), 'digest', { email: 'mere@example.com', firstName: 'Mere', tenant: tenantA.id }, { linked: { collection: 'jobs', id: 7 } })

    expect(result.status).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: { address: 'hello-a@example.test', name: 'Site A' }, subject: 'Hi Mere', to: 'mere@example.com' })
    expect(sent[0]?.html).toContain('Kia ora Mere')
    expect(sent[0]?.html).toContain('#0a6e3f')
    expect(sent[0]?.text).toContain('Kia ora Mere')

    const [row] = await rows(tenantA.id)
    expect(row).toMatchObject({ event: 'digest', linkedCollection: 'jobs', linkedID: '7', recipient: 'mere@example.com', redirected: false, status: 'sent' })
    expect(String((row as { template: unknown }).template)).toBe(String(created.id))
    // The log keeps no message: no body, subject, html or text field exists at all.
    expect(Object.keys(row as object).filter((key) => /body|subject|html|text|attachment/i.test(key))).toEqual([])
    expect(JSON.stringify(row)).not.toContain('Kia ora')
  })

  it('uses the event’s default text when the tenant has no template', async () => {
    const result = await sendTemplateWith(ctx(), 'digest', { email: 'a@example.com', firstName: 'Ana' }, { tenant: harness.tenantA.id })

    expect(result.status).toBe('sent')
    expect(sent[0]?.subject).toBe('Default for Ana')
    expect((await rows(harness.tenantA.id))[0]?.template ?? null).toBeNull()
  })

  it('skips an event the tenant switched off, and logs it with the reason @S-187', async () => {
    await template(harness.tenantA.id, { enabled: false })
    await template(harness.tenantB.id, { enabled: true })

    const a = await sendTemplateWith(ctx(), 'digest', { email: 'a@example.com', firstName: 'A' }, { tenant: harness.tenantA.id })
    const b = await sendTemplateWith(ctx(), 'digest', { email: 'b@example.com', firstName: 'B' }, { tenant: harness.tenantB.id })

    expect(a.status).toBe('skipped')
    expect(b.status).toBe('sent')
    expect(sent.map((message) => message.to)).toEqual(['b@example.com'])
    expect(await rows(harness.tenantA.id)).toMatchObject([{ reason: 'disabled', status: 'skipped' }])
    expect(await rows(harness.tenantB.id)).toMatchObject([{ status: 'sent' }])
  })

  it('never reads another tenant’s template or mixes tenants', async () => {
    await template(harness.tenantB.id, { subject: 'B only {{firstName}}' })

    await sendTemplateWith(ctx(), 'digest', { email: 'a@example.com', firstName: 'A' }, { tenant: harness.tenantA.id })

    expect(sent[0]?.subject).toBe('Default for A')
    expect(sent[0]?.from.address).toBe('hello-a@example.test')
    await expect(
      sendTemplateWith(ctx(), 'digest', { email: 'a@example.com', tenant: harness.tenantB.id }, { tenant: harness.tenantA.id }),
    ).rejects.toThrow(/tenant does not match/)
    expect(sent).toHaveLength(1)
    expect(await rows(harness.tenantB.id)).toEqual([])
  })

  it('refuses an unknown event and a multi-tenant send with no tenant', async () => {
    await expect(sendTemplateWith(ctx(), 'nope', {})).rejects.toThrow(/unknown email event/)
    await expect(sendTemplateWith(ctx(), 'digest', { email: 'a@example.com' })).rejects.toThrow(/no tenant/)
  })

  it('redirects non-production mail to the test inbox and keeps the real recipient out of delivery', async () => {
    redirect = () => ({ label: 'preview', to: 'inbox@example.test' })

    const result = await sendTemplateWith(ctx(), 'digest', { email: 'public@example.com', firstName: 'P' }, { tenant: harness.tenantA.id })

    expect(result).toMatchObject({ redirected: true, status: 'sent' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('inbox@example.test')
    expect(sent[0]?.subject).toBe('[preview → public@example.com] Default for P')
    expect((await rows(harness.tenantA.id))[0]).toMatchObject({ recipient: 'public@example.com', redirected: true })
  })

  it('delivers nothing when the redirect is on but has no inbox', async () => {
    redirect = () => ({ label: 'preview' })

    const result = await sendTemplateWith(ctx(), 'digest', { email: 'public@example.com', firstName: 'P' }, { tenant: harness.tenantA.id })

    expect(result.status).toBe('skipped')
    expect(sent).toEqual([])
    expect((await rows(harness.tenantA.id))[0]).toMatchObject({ reason: 'non-production: no redirect inbox', redirected: true })
  })

  it('logs a failed send without throwing, and keeps addresses out of the reason', async () => {
    failWith = new Error('550 rejected mere@example.com: mailbox full')

    const result = await sendTemplateWith(ctx(), 'digest', { email: 'mere@example.com', firstName: 'M' }, { tenant: harness.tenantA.id })

    expect(result.status).toBe('failed')
    const [row] = await rows(harness.tenantA.id)
    expect(row).toMatchObject({ status: 'failed' })
    expect(String(row?.reason)).toContain('m***@example.com')
    expect(String(row?.reason)).not.toContain('mere@')
  })

  it('logs a skipped send when there is nobody to send to', async () => {
    const result = await sendTemplateWith(ctx(), 'digest', { firstName: 'X' }, { tenant: harness.tenantA.id })
    expect(result.status).toBe('skipped')
    expect(sent).toEqual([])
  })

  describe('templates @S-181', () => {
    it('allows one template per event and site', async () => {
      await template(harness.tenantA.id, {})
      await expect(template(harness.tenantA.id, {})).rejects.toThrow()
      await expect(template(harness.tenantB.id, {})).resolves.toBeTruthy()
    })

    it('rejects a variable the event does not declare, in the subject and the body', async () => {
      await expect(template(harness.tenantA.id, { subject: 'Hi {{nickname}}' })).rejects.toThrow()
      await expect(template(harness.tenantA.id, { body: chipBody('nickname') })).rejects.toThrow()
      await expect(template(harness.tenantA.id, { body: chipBody('firstName'), subject: 'Hi {{firstName}}' })).resolves.toBeTruthy()
    })

    it('scopes templates to the staff member’s own site', async () => {
      const mine = await template(harness.tenantA.id, {})
      await template(harness.tenantB.id, {})

      const { docs } = await payload.find({ collection: 'email-templates' as never, user: harness.tenantAdminA as never })
      expect(docs.map((doc) => String(doc.id))).toEqual([String(mine.id)])
      await expect(
        payload.create({ collection: 'email-templates' as never, data: { event: 'digest', tenant: harness.tenantB.id } as never, user: harness.tenantAdminA as never }),
      ).rejects.toThrow()
    })
  })

  describe('log access @S-183', () => {
    it('lets staff read only their own site’s log, and no one write it', async () => {
      await sendTemplateWith(ctx(), 'digest', { email: 'a@example.com', firstName: 'A' }, { tenant: harness.tenantA.id })
      await sendTemplateWith(ctx(), 'digest', { email: 'b@example.com', firstName: 'B' }, { tenant: harness.tenantB.id })

      const { docs } = await payload.find({ collection: 'email-log' as never, user: harness.tenantAdminA as never })
      expect(docs.map((doc) => (doc as { recipient?: string }).recipient)).toEqual(['a@example.com'])

      const id = docs[0]?.id as number
      await expect(payload.update({ collection: 'email-log' as never, data: { status: 'sent' } as never, id, user: harness.superAdmin as never })).rejects.toThrow()
      await expect(payload.delete({ collection: 'email-log' as never, id, user: harness.superAdmin as never })).rejects.toThrow()
      await expect(
        payload.create({ collection: 'email-log' as never, data: { event: 'x', sentAt: new Date().toISOString(), status: 'sent', tenant: harness.tenantA.id } as never, user: harness.superAdmin as never }),
      ).rejects.toThrow()
    })
  })

  describe('retention and volume @S-184 @S-185', () => {
    const now = new Date('2026-11-24T03:30:00Z')
    const add = (tenant: number, sentAt: string, extra: Record<string, unknown> = {}) =>
      payload.create({
        collection: 'email-log' as never,
        data: { event: 'digest', recipient: 'jane@example.com', sentAt, status: 'sent', tenant, ...extra } as never,
        overrideAccess: true,
      })
    const scopeFor = async (tenantID: number) => {
      const tenant = await payload.findByID({ collection: 'tenants', depth: 0, id: tenantID, overrideAccess: true })
      return { retention: logRetention(tenant as never), tenantID }
    }
    const run = async (tenantID: number) =>
      applyEmailLogRetention({ logSlug: 'email-log', now, payload, scope: await scopeFor(tenantID) })

    it('masks at the visible boundary and deletes at the delete boundary, per tenant', async () => {
      const a = harness.tenantA.id
      await add(a, '2026-08-26T03:30:00.000Z') // exactly 90 days: masked
      await add(a, '2026-08-26T03:30:01.000Z') // one second inside: still visible
      await add(a, '2025-11-24T03:30:00.000Z') // exactly 12 months: deleted
      await add(a, '2025-11-24T03:30:01.000Z') // one second inside 12 months: kept (masked)

      const result = await run(a)

      expect(result).toEqual({ deleted: 1, masked: 2 })
      const left = (await rows(a)).sort((x, y) => String(x.sentAt).localeCompare(String(y.sentAt)))
      expect(left.map((row) => [row.sentAt, row.recipient, row.recipientMasked])).toEqual([
        ['2025-11-24T03:30:01.000Z', 'j***@example.com', true],
        ['2026-08-26T03:30:00.000Z', 'j***@example.com', true],
        ['2026-08-26T03:30:01.000Z', 'jane@example.com', false],
      ])
      // A second run finds nothing to do.
      expect(await run(a)).toEqual({ deleted: 0, masked: 0 })
    })

    it('uses each tenant’s own periods and never touches another tenant’s rows', async () => {
      const [a, b] = [harness.tenantA.id, harness.tenantB.id]
      await payload.update({ collection: 'tenants', data: { emailLogRetention: { deleteMonths: 3, visibleDays: 7 } } as never, id: a, overrideAccess: true })
      await add(a, '2026-11-01T00:00:00.000Z') // 23 days: masked for A (7 days), visible for B (90)
      await add(a, '2026-07-01T00:00:00.000Z') // > 3 months: deleted for A
      await add(b, '2026-11-01T00:00:00.000Z')
      await add(b, '2026-07-01T00:00:00.000Z') // B keeps it, masks nothing yet (145 days → masked at 90)

      expect(await run(a)).toEqual({ deleted: 1, masked: 1 })
      expect((await rows(b)).every((row) => row.recipientMasked === false)).toBe(true)
      expect(await run(b)).toEqual({ deleted: 0, masked: 1 })
      expect(await rows(b)).toHaveLength(2)
    })

    it('counts the month’s sent emails per tenant, not skipped or failed ones', async () => {
      const [a, b] = [harness.tenantA.id, harness.tenantB.id]
      await add(a, '2026-11-01T00:00:00.000Z') // first instant of November: counted
      await add(a, '2026-11-30T23:59:59.999Z')
      await add(a, '2026-12-01T00:00:00.000Z') // December
      await add(a, '2026-10-31T23:59:59.999Z') // October
      await add(a, '2026-11-10T00:00:00.000Z', { status: 'skipped' })
      await add(a, '2026-11-11T00:00:00.000Z', { status: 'failed' })
      await add(b, '2026-11-12T00:00:00.000Z')

      const count = (tenantID: number, month: string) => monthlyEmailVolume({ logSlug: 'email-log', month, payload, tenantID })

      expect(await count(a, '2026-11')).toBe(2)
      expect(await count(a, '2026-10')).toBe(1)
      expect(await count(a, '2026-12')).toBe(1)
      expect(await count(b, '2026-11')).toBe(1)
      const byMonth = await emailVolumeByMonth({ logSlug: 'email-log', months: 3, now, payload, tenantID: a })
      expect(byMonth).toEqual([
        { count: 2, month: '2026-11' },
        { count: 1, month: '2026-10' },
        { count: 0, month: '2026-09' },
      ])
    })
  })
})
