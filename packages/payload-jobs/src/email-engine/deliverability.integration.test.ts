import type { Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { bootTestPayload, type TestHarness } from '../test'
import { eventFor } from './__fixtures__/delivery-events'
import { applyDeliveryEvent, deliverabilityStats, parseDeliveryEvent, type DeliverabilityContext } from './deliverability'
import { createEmailEventRegistry, type EmailTemplateEvent } from './events'
import { emailLogCollection } from './log'
import { sendTemplateWith, type EmailEngineContext } from './send'
import { tenantEmailFields } from './settings'
import { emailSuppressionsCollection, isEmailSuppressed } from './suppressions'
import { emailTemplatesCollection } from './templates'

const databaseUrl = process.env.TEST_DATABASE_URL

const events = createEmailEventRegistry([
  {
    defaultBody: [['Hello ', { variable: 'firstName' }]],
    defaultSubject: 'Digest',
    label: 'Alert digest',
    recipient: (doc) => doc.email as string,
    slug: 'digest',
    variables: [{ key: 'firstName', label: 'First name', resolve: (doc) => doc.firstName as string }],
  } satisfies EmailTemplateEvent,
])

describe.skipIf(!databaseUrl)('email deliverability @S-385 @S-386 @S-387', () => {
  let harness: TestHarness
  let payload: Payload
  let nextId = 0

  const engine = (): EmailEngineContext => ({
    events,
    logSlug: 'email-log',
    payload,
    sendEmail: async () => ({ messageId: `<msg-${++nextId}@mail.example>` }),
    settingsSlug: 'job-board-settings',
    suppressionsSlug: 'email-suppressions',
    templatesSlug: 'email-templates',
    tenancy: 'multi',
    tenantsSlug: 'tenants',
  })
  const deliver = (): DeliverabilityContext => ({ logSlug: 'email-log', payload, suppressionsSlug: 'email-suppressions' })
  const send = (tenant: number, email = 'mere@example.com') =>
    sendTemplateWith(engine(), 'digest', { email, firstName: 'Mere', tenant })
  const row = async (id: number | string) =>
    (await payload.findByID({ collection: 'email-log' as never, depth: 0, id, overrideAccess: true })) as unknown as Record<string, unknown>
  const apply = (kind: string, messageId: string, extra: Record<string, unknown> = {}) =>
    applyDeliveryEvent(deliver(), parseDeliveryEvent(eventFor(kind, messageId, extra))!)

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: [emailTemplatesCollection({ events }), emailLogCollection(), emailSuppressionsCollection()],
      tenantData: (which) => ({ emailFromAddress: `hello-${which.toLowerCase()}@example.test` }),
      tenantFields: [{ name: 'emailFromAddress', type: 'email' }, ...tenantEmailFields()],
    })
    payload = harness.payload
  })
  afterAll(async () => {
    if (harness) await harness.destroy()
  })
  beforeEach(async () => {
    nextId = 0
    for (const collection of ['email-log', 'email-suppressions']) {
      await payload.delete({ collection: collection as never, overrideAccess: true, where: { id: { exists: true } } })
    }
  })

  it('stores the message id without angle brackets and moves the row on delivery', async () => {
    const { tenantA } = harness
    const result = await send(tenantA.id)
    expect((await row(result.logID!)).messageId).toBe('msg-1@mail.example')

    expect((await apply('delivered', '<msg-1@mail.example>')).outcome).toBe('applied')
    expect(await row(result.logID!)).toMatchObject({ status: 'delivered' })
    expect((await row(result.logID!)).statusAt).toBeTruthy()
  })

  it('never moves a row backwards when events arrive out of order', async () => {
    const { tenantA } = harness
    const result = await send(tenantA.id)
    await apply('delivered', 'msg-1@mail.example')
    expect((await apply('deferred', 'msg-1@mail.example')).outcome).toBe('ignored')
    expect(await row(result.logID!)).toMatchObject({ status: 'delivered' })
  })

  it('a hard bounce suppresses the address for that tenant only, and sendTemplate then skips it', async () => {
    const { tenantA, tenantB } = harness
    const first = await send(tenantA.id)
    const outcome = await apply('bounced', 'msg-1@mail.example')

    expect(outcome).toEqual({ outcome: 'applied', suppressed: true })
    expect(await row(first.logID!)).toMatchObject({ bounceType: 'hard', status: 'bounced' })
    expect(await isEmailSuppressed({ address: 'MERE@example.com', payload, tenantID: tenantA.id, slug: 'email-suppressions' })).toBe(true)
    expect(await isEmailSuppressed({ address: 'mere@example.com', payload, tenantID: tenantB.id, slug: 'email-suppressions' })).toBe(false)

    const again = await send(tenantA.id, 'Mere@Example.com')
    expect(again).toMatchObject({ status: 'skipped' })
    expect(await row(again.logID!)).toMatchObject({ reason: 'suppressed' })
    expect((await send(tenantB.id)).status).toBe('sent')
  })

  it('a complaint suppresses; a soft bounce and a deferral only record @S-386', async () => {
    const { tenantA } = harness
    await send(tenantA.id, 'soft@example.com')
    await send(tenantA.id, 'later@example.com')
    await send(tenantA.id, 'angry@example.com')

    expect((await apply('bounced', 'msg-1@mail.example', { bounce: { type: 'soft' } })).suppressed).toBe(false)
    expect((await apply('deferred', 'msg-2@mail.example')).suppressed).toBe(false)
    expect((await apply('complained', 'msg-3@mail.example')).suppressed).toBe(true)

    const suppressed = (await payload.find({ collection: 'email-suppressions' as never, depth: 0, overrideAccess: true, pagination: false })).docs
    expect(suppressed.map((doc) => (doc as unknown as { address: string }).address)).toEqual(['angry@example.com'])
    expect(suppressed[0]).toMatchObject({ reason: 'complaint' })
  })

  it('does not suppress a redirected (non-production) send, and ignores an unknown message', async () => {
    const { tenantA } = harness
    const ctx = { ...engine(), redirect: () => ({ to: 'inbox@example.test' }) }
    await sendTemplateWith(ctx, 'digest', { email: 'real@example.com', firstName: 'R', tenant: tenantA.id })

    expect((await apply('bounced', 'msg-1@mail.example')).suppressed).toBe(false)
    expect((await apply('delivered', 'no-such-message')).outcome).toBe('unknown-message')
  })

  it('counts the last 30 days per tenant @S-387', async () => {
    const { tenantA, tenantB } = harness
    for (const n of [1, 2, 3, 4]) await send(tenantA.id, `p${n}@example.com`)
    await send(tenantB.id, 'other@example.com')
    await apply('delivered', 'msg-1@mail.example')
    await apply('delivered', 'msg-2@mail.example')
    await apply('bounced', 'msg-3@mail.example')
    await apply('complained', 'msg-4@mail.example')

    const args = { logSlug: 'email-log', payload }
    expect(await deliverabilityStats({ ...args, tenantID: tenantA.id })).toEqual({ bounced: 1, complaints: 1, delivered: 2, sent: 4 })
    expect(await deliverabilityStats({ ...args, tenantID: tenantB.id })).toEqual({ bounced: 0, complaints: 0, delivered: 0, sent: 1 })
    expect(await deliverabilityStats({ ...args, now: new Date(Date.now() + 40 * 86_400_000), tenantID: tenantA.id })).toMatchObject({ sent: 0 })
  })
})
