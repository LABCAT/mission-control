import { createPayloadRequest, type CollectionConfig, type Field, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addOnCollection } from '../add-ons'
import { couponCollection } from '../coupons'
import { locationsCollection } from '../collections/locations'
import { planCollection, withPlanRestrictionGuards } from '../plans'
import { taxonomyCollections } from '../taxonomies'
import { jobsCollection } from '../collections/jobs'
import { organisationField, organisationRoleField, organisationsCollection } from '../collections/organisations'
import { orderCollection } from '../orders'
import { bootTestPayload, type TestHarness } from '../test'
import { createEmailEventRegistry } from './events'
import { emailLogCollection } from './log'
import { jobNotificationHook, orderNotificationHook, organisationNotificationHook, type NotificationHookOptions } from './notifications'
import { tenantEmailFields } from './settings'
import { emailTemplatesCollection } from './templates'

/**
 * The job, order and organisation emails against a real Postgres (PJ-51): who receives what,
 * the one-email rule, the per-event switch, idempotency and tenant isolation.
 */

const databaseUrl = process.env.TEST_DATABASE_URL

type Doc = Record<string, any> & { id: number }

const options: NotificationHookOptions = {
  jobsSlug: 'jobs',
  ordersSlug: 'orders',
  organisationsSlug: 'organisations',
  tenancy: 'multi',
  usersSlug: 'users',
}

const withAfterChange = (collection: CollectionConfig, hook: any): CollectionConfig => ({
  ...collection,
  hooks: { ...collection.hooks, afterChange: [...(collection.hooks?.afterChange ?? []), hook] },
})

describe.skipIf(!databaseUrl)('job, order and organisation emails @S-365 @S-366 @S-367 @S-368', () => {
  let harness: TestHarness
  let payload: Payload
  let sent: { subject: string; to: string }[] = []
  const system = { overrideAccess: true } as const

  beforeAll(async () => {
    const events = createEmailEventRegistry()
    harness = await bootTestPayload({
      collections: [
        withAfterChange(orderCollection(), orderNotificationHook(options)),
        withAfterChange(jobsCollection({ richTextDescription: false, withOrder: true }), jobNotificationHook(options)),
        withAfterChange(organisationsCollection({ mediaSlug: null }), organisationNotificationHook(options)),
        couponCollection(),
        planCollection(),
        addOnCollection(),
        locationsCollection({ requireTenant: true }),
        ...withPlanRestrictionGuards(taxonomyCollections({ tenantScoped: true })),
        emailTemplatesCollection({ events }),
        emailLogCollection(),
      ],
      tenantData: (which) => ({
        adminEmail: `admin-${which.toLowerCase()}@site.test`,
        emailFromAddress: `hello-${which.toLowerCase()}@site.test`,
        emailFromName: `Site ${which}`,
      }),
      tenantFields: [
        { name: 'adminEmail', type: 'email' },
        { name: 'emailFromAddress', type: 'email' },
        { name: 'emailFromName', type: 'text' },
        ...tenantEmailFields(),
      ],
      userFields: [organisationField(), organisationRoleField(), { name: 'firstName', type: 'text' }] as Field[],
    })
    payload = harness.payload
    ;(payload.config as { custom?: Record<string, unknown> }).custom = {
      ...payload.config.custom,
      payloadJobs: {
        email: { events, logSlug: 'email-log', settingsSlug: 'job-board-settings', templatesSlug: 'email-templates', tenancy: 'multi', tenantsSlug: 'tenants' },
      },
    }
    ;(payload as { sendEmail: unknown }).sendEmail = async (message: { subject: string; to: string }) => {
      sent.push({ subject: message.subject, to: message.to })
    }
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  beforeEach(async () => {
    sent = []
    await payload.delete({ collection: 'email-log' as never, where: { id: { exists: true } }, ...system })
    await payload.delete({ collection: 'email-templates' as never, where: { id: { exists: true } }, ...system })
  })

  const tag = () => Math.random().toString(36).slice(2, 8)

  /** An organisation with an owner who is also the job's creator. */
  const setup = async (tenant: number, extra: Record<string, unknown> = {}) => {
    const organisation = (await payload.create({
      collection: 'organisations' as never,
      data: { name: `Brew ${tag()}`, slug: `brew-${tag()}`, tenant, ...extra } as never,
      ...system,
    })) as Doc
    const owner = (await payload.create({
      collection: 'users' as never,
      data: {
        email: `owner-${tag()}@brew.test`,
        firstName: 'Olu',
        organisation: organisation.id,
        organisationRole: 'owner',
        password: 'test-password',
        role: 'user',
        tenants: [{ role: 'employer', tenant }],
      } as never,
      ...system,
    })) as Doc
    sent = []

    return { organisation, owner }
  }

  const makeOrder = (organisation: Doc, extra: Record<string, unknown> = {}) =>
    payload.create({
      collection: 'orders' as never,
      data: {
        currency: 'VUV', discount: 0, organisation: organisation.id, paymentMethod: 'invoice', paymentProvider: 'invoice',
        status: 'pending', subtotal: 3900, tax: 0, tenant: organisation.tenant, total: 3900, ...extra,
      } as never,
      ...system,
    }) as Promise<Doc>

  const makeJob = (organisation: Doc, owner: Doc, extra: Record<string, unknown> = {}) =>
    payload.create({
      collection: 'jobs' as never,
      data: { organisation: organisation.id, status: 'draft', tenant: organisation.tenant, title: `Cook ${tag()}`, ...extra } as never,
      user: { ...owner, collection: 'users' } as never,
      ...system,
    }) as Promise<Doc>

  const toList = () => sent.map((entry) => entry.to).sort()
  const logRows = async (tenant: number) =>
    (await payload.find({ collection: 'email-log' as never, depth: 0, pagination: false, where: { tenant: { equals: tenant } }, ...system })).docs as unknown as Doc[]

  it('sends one submitted email to the employer with the order details, and one to the admin', async () => {
    const { tenantA } = harness
    const { organisation, owner } = await setup(tenantA.id)
    const job = await makeJob(organisation, owner)
    const order = await makeOrder(organisation, { jobs: [job.id] })
    await payload.update({ collection: 'jobs' as never, data: { order: order.id } as never, id: job.id, ...system })
    // The order came with the job, so it says nothing of its own.
    expect(sent).toEqual([])

    await payload.update({ collection: 'jobs' as never, data: { status: 'pending' } as never, id: job.id, ...system })

    expect(toList()).toEqual([owner.email, 'admin-a@site.test'].sort())
    expect(sent.find((entry) => entry.to === owner.email)?.subject).toContain(job.title)
    const rows = await logRows(tenantA.id)
    expect(rows.map((row) => row.event).sort()).toEqual(['job-submitted', 'job-submitted-admin'])
    expect(rows.every((row) => row.linkedCollection === 'jobs' && String(row.linkedID) === String(job.id))).toBe(true)
  })

  it('does not email twice when the same state is saved again', async () => {
    const { organisation, owner } = await setup(harness.tenantA.id)
    const job = await makeJob(organisation, owner, { status: 'pending' })
    sent = []

    await payload.update({ collection: 'jobs' as never, data: { status: 'pending' } as never, id: job.id, ...system })
    expect(sent).toEqual([])
  })

  it('sends no second email when the job goes live in the request that submitted it', async () => {
    const { organisation, owner } = await setup(harness.tenantA.id)
    const req = await createPayloadRequest({ payload, user: null as never })
    const job = (await payload.create({
      collection: 'jobs' as never,
      data: { organisation: organisation.id, status: 'pending', tenant: organisation.tenant, title: 'Cook' } as never,
      user: { ...owner, collection: 'users' } as never,
      req,
      ...system,
    })) as Doc
    sent = []
    const req2 = await createPayloadRequest({ payload, user: null as never })
    await payload.update({ collection: 'jobs' as never, data: { status: 'published' } as never, id: job.id, req: req2, ...system })
    // A later action (the manager approves) is its own email.
    expect(toList()).toEqual([owner.email])
  })

  it('sends the order emails only for an order without a job, and a copy to the billing address of an invoice-me organisation', async () => {
    const { organisation } = await setup(harness.tenantA.id, { billingEmail: 'accounts@brew.test', canPayByInvoice: true })
    const owner = (await payload.find({ collection: 'users' as never, where: { organisation: { equals: organisation.id } }, ...system })).docs[0] as Doc
    const withJob = await makeJob(organisation, owner)
    await makeOrder(organisation, { jobs: [withJob.id] })
    expect(sent).toEqual([])

    await makeOrder(organisation)
    expect(toList()).toEqual(['accounts@brew.test', 'admin-a@site.test', owner.email].sort())
  })

  it('sends one email when an order is paid or cancelled, and none when it is saved again @S-110', async () => {
    const { organisation, owner } = await setup(harness.tenantA.id)
    const order = await makeOrder(organisation, { status: 'invoiced' })
    sent = []

    await payload.update({ collection: 'orders' as never, data: { status: 'paid' } as never, id: order.id, ...system })
    expect(toList()).toEqual([owner.email])
    expect(sent[0]?.subject).toContain(String(order.id))
    sent = []
    await payload.update({ collection: 'orders' as never, data: { statusNote: 'again' } as never, id: order.id, ...system })
    expect(sent).toEqual([])

    const other = await makeOrder(organisation, { status: 'pending' })
    sent = []
    await payload.update({ collection: 'orders' as never, data: { status: 'cancelled' } as never, id: other.id, ...system })
    expect(toList()).toEqual([owner.email])
  })

  it('tells the admin of a page request and the owner of its approval', async () => {
    const { organisation, owner } = await setup(harness.tenantA.id)

    await payload.update({ collection: 'organisations' as never, data: { listingRequested: true } as never, id: organisation.id, ...system })
    expect(toList()).toEqual(['admin-a@site.test'])
    sent = []
    await payload.update({ collection: 'organisations' as never, data: { pageEnabled: true } as never, id: organisation.id, ...system })
    expect(toList()).toEqual([owner.email])
  })

  it('honours the per-event switch: a disabled event is logged as skipped, the others still go', async () => {
    const { tenantA } = harness
    const { organisation, owner } = await setup(tenantA.id)
    await payload.create({ collection: 'email-templates' as never, data: { enabled: false, event: 'job-submitted-admin', tenant: tenantA.id } as never, ...system })
    const job = await makeJob(organisation, owner)

    await payload.update({ collection: 'jobs' as never, data: { status: 'pending' } as never, id: job.id, ...system })

    expect(toList()).toEqual([owner.email])
    const rows = await logRows(tenantA.id)
    expect(rows.find((row) => row.event === 'job-submitted-admin')).toMatchObject({ reason: 'disabled', status: 'skipped' })
  })

  it('keeps tenants apart: each site’s admin and switch apply to its own jobs only', async () => {
    const { tenantA, tenantB } = harness
    await payload.create({ collection: 'email-templates' as never, data: { enabled: false, event: 'job-submitted-admin', tenant: tenantA.id } as never, ...system })
    const b = await setup(tenantB.id)
    const job = await makeJob(b.organisation, b.owner)

    await payload.update({ collection: 'jobs' as never, data: { status: 'pending' } as never, id: job.id, ...system })

    expect(toList()).toEqual([b.owner.email, 'admin-b@site.test'].sort())
    expect(await logRows(tenantA.id)).toEqual([])
    expect((await logRows(tenantB.id)).every((row) => row.status === 'sent')).toBe(true)
  })
})
