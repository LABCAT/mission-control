import { postgresAdapter, sql } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { buildConfig, getPayload, type CollectionConfig, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  isSuperAdmin,
  ORDERS_SLUG,
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  globalRoleOptions,
  tenantRoleOptions,
} from '@mission-control/payload-jobs'
import {
  DEFAULT_INVOICES_SLUG,
  DEFAULT_SETTINGS_SLUG,
  findSettingsWithTokens,
  generateEncryptionKey,
  resolveXeroInvoicing,
  saveXeroTokens,
  syncXeroInvoice,
  XERO_INVOICE_SYNC_QUEUE,
  XERO_INVOICE_SYNC_TASK_SLUG,
  XeroInvoiceError,
} from '@mission-control/payload-xero'

import { orderInvoiceAdapter, payloadJobsXero, seedXeroSettings, xeroTenantCollections } from './index'
import { getPayloadJobsRegistry } from '@mission-control/payload-jobs'
import { FakeXero, networkError, rejected, unavailable } from './test/fake-xero'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = `mc_test_xero_${Math.random().toString(36).slice(2, 8)}`
const INSTANCE_KEY = `payload-jobs-xero-test-${SCHEMA}`
const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const ENCRYPTION_KEY = generateEncryptionKey()

const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  fields: [{ name: 'role', type: 'select', defaultValue: 'user', options: globalRoleOptions, required: true, saveToJWT: true }],
  versions: false,
}
const Tenants: CollectionConfig = {
  slug: 'tenants',
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

type Doc = Record<string, any> & { id: number }

const xero = new FakeXero()
let payload: Payload
let config: ReturnType<typeof resolveXeroInvoicing>
const tenants: Record<'a' | 'b' | 'off', Doc> = {} as never
const orgs: Record<'a' | 'b' | 'off', Doc> = {} as never
let planA: Doc
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const createOrder = async (tenant: Doc, organisation: Doc, extra: Record<string, unknown> = {}): Promise<Doc> =>
  (await payload.create({
    collection: ORDERS_SLUG,
    data: {
      currency: 'VUV',
      discount: 0,
      organisation: organisation.id,
      paymentMethod: 'invoice',
      paymentProvider: 'invoice',
      plan: tenant.id === tenants.a.id ? planA.id : undefined,
      subtotal: 3900,
      tax: 0,
      tenant: tenant.id,
      total: 3900,
      ...extra,
    } as never,
    overrideAccess: true,
  })) as unknown as Doc

const readOrder = async (id: number): Promise<Doc> =>
  (await payload.findByID({ collection: ORDERS_SLUG, depth: 0, id, overrideAccess: true })) as unknown as Doc

const setStatus = async (id: number, status: string): Promise<Doc> =>
  (await payload.update({ collection: ORDERS_SLUG, data: { status } as never, depth: 0, id, overrideAccess: true })) as unknown as Doc

const syncRow = async (orderID: number): Promise<Doc | undefined> =>
  (
    await payload.find({
      collection: DEFAULT_INVOICES_SLUG as never,
      depth: 0,
      overrideAccess: true,
      where: { and: [{ source: { equals: ORDERS_SLUG } }, { sourceId: { equals: String(orderID) } }] },
    })
  ).docs[0] as unknown as Doc | undefined

const queuedRetries = async (orderID: number): Promise<Doc[]> =>
  (
    await payload.find({
      collection: 'payload-jobs' as never,
      depth: 0,
      overrideAccess: true,
      where: { taskSlug: { equals: XERO_INVOICE_SYNC_TASK_SLUG } },
    })
  ).docs.filter((job: any) => String(job.input?.sourceId) === String(orderID)) as unknown as Doc[]

const invoicesFor = (orderID: number, org = ORG_A) =>
  xero.invoicesOf(org).filter((invoice) => invoice.Reference === `Order ${orderID}`)

/** Hide the order from the hook by changing its status straight in the database. */
const quietStatus = (id: number, status: string) =>
  payload.db.updateOne({ collection: ORDERS_SLUG, data: { status }, where: { id: { equals: id } } })

describe('Xero invoicing for orders', () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests')
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

    const xeroOptions = {
      xero: { oauth: { encryptionKey: ENCRYPTION_KEY, fetch: xero.fetch } },
    }
    const built = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Tenants],
      db: postgresAdapter({ pool: { connectionString: databaseUrl, max: 10 }, push: true, schemaName: SCHEMA }),
      plugins: [
        payloadJobs({ accountAuth: false, tenancy: 'multi' }),
        payloadJobsXero(xeroOptions),
        multiTenantPlugin({
          collections: Object.fromEntries(
            [...PAYLOAD_JOBS_TENANT_COLLECTIONS, ...xeroTenantCollections(xeroOptions)].map((slug) => [slug, {}]),
          ),
          tenantsArrayField: {
            rowFields: [{ name: 'role', type: 'select', options: tenantRoleOptions, required: true, saveToJWT: true }],
          },
          tenantsSlug: 'tenants',
          userHasAccessToAllTenants: (user) => isSuperAdmin(user as never),
        }),
      ],
      secret: 'test-secret',
    })
    payload = await getPayload({ config: built, key: INSTANCE_KEY })
    // The resolved invoicing, as the plugin built it, for calling the sync directly.
    config = resolveXeroInvoicing({
      invoicing: { adapter: orderInvoiceAdapter({ registry: getPayloadJobsRegistry(built as never) }) },
      oauth: xeroOptions.xero.oauth,
      scope: 'tenant',
    })

    const tenant = async (name: string, extra: Record<string, unknown> = {}) =>
      (await payload.create({
        collection: 'tenants',
        data: {
          adminEmail: `admin@${name}.example.invalid`,
          currency: 'VUV',
          currencyMinorUnits: 0,
          defaultLocale: 'en',
          emailFromAddress: `jobs@${name}.example.invalid`,
          emailFromName: `${name} Jobs`,
          locales: [{ locale: 'en' }],
          name,
          slug: `${name}-${runId}`,
          taxLabel: 'VAT',
          timezone: 'Pacific/Efate',
          ...extra,
        } as never,
        overrideAccess: true,
      })) as unknown as Doc
    tenants.a = await tenant('a')
    tenants.b = await tenant('b')
    tenants.off = await tenant('off', { addOns: [] })

    const org = async (t: Doc, name: string, extra: Record<string, unknown> = {}) =>
      (await payload.create({
        collection: 'organisations',
        data: { name, slug: `${name.toLowerCase()}-${runId}`, tenant: t.id, ...extra } as never,
        overrideAccess: true,
      })) as unknown as Doc
    orgs.a = await org(tenants.a, 'Brew', { billingEmail: 'accounts@brew.example.invalid', legacyId: 4521 })
    orgs.b = await org(tenants.b, 'Shop')
    orgs.off = await org(tenants.off, 'Quiet')

    planA = (await payload.create({
      collection: 'plans',
      data: { durationDays: 45, jobCredits: 1, key: 'basic', name: 'Basic', price: 3900, tenant: tenants.a.id } as never,
      overrideAccess: true,
    })) as unknown as Doc

    // vwok's seed for tenant A; tenant B is connected to another Xero organisation; the
    // add-on-off tenant is connected too, so only the switch keeps it out.
    const seed = {
      accountCodes: { addOn: '226', discount: '227', plan: '225' },
      authorise: true,
      dueDays: 14,
      reconciliationAccountCode: null,
      trackingCategory: null,
    }
    for (const [t, xeroOrg] of [
      [tenants.a, ORG_A],
      [tenants.b, ORG_B],
      [tenants.off, ORG_B],
    ] as const) {
      expect(await seedXeroSettings({ payload, seed, tenantID: t.id })).toEqual({ applied: true })
      const { docs } = await payload.find({
        collection: DEFAULT_SETTINGS_SLUG as never,
        overrideAccess: true,
        where: { tenant: { equals: t.id } },
      })
      const row = await findSettingsWithTokens({ collection: DEFAULT_SETTINGS_SLUG, id: docs[0]!.id, payload })
      await saveXeroTokens({
        collection: DEFAULT_SETTINGS_SLUG,
        data: { xeroTenantId: xeroOrg },
        encryptionKey: ENCRYPTION_KEY,
        payload,
        settings: row!,
        tokens: {
          accessToken: 'test-access-token',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          refreshToken: 'test-refresh-token',
          scope: null,
        },
      })
    }
  })

  beforeEach(() => {
    xero.faults = []
  })

  afterAll(async () => {
    if (!payload) return
    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  it('seeds vwok’s settings once and keeps an existing row @S-102', async () => {
    const seed = {
      accountCodes: { addOn: '1', discount: '2', plan: '3' },
      authorise: false,
      dueDays: 7,
      reconciliationAccountCode: null,
      trackingCategory: null,
    }
    expect(await seedXeroSettings({ payload, seed, tenantID: tenants.a.id })).toEqual({ applied: false })

    const { docs } = await payload.find({
      collection: DEFAULT_SETTINGS_SLUG as never,
      overrideAccess: true,
      where: { tenant: { equals: tenants.a.id } },
    })
    expect(docs[0]).toMatchObject({
      accountCodes: { addOn: '226', discount: '227', plan: '225' },
      dueDays: 14,
      invoicing: { authorise: true },
    })
  })

  it('creates a draft for a new order, records it on the order and logs it @S-102', async () => {
    const order = await createOrder(tenants.a, orgs.a)

    const [invoice, ...others] = invoicesFor(order.id)
    expect(others).toHaveLength(0)
    expect(invoice).toMatchObject({
      CurrencyCode: 'VUV',
      LineAmountTypes: 'NoTax',
      LineItems: [{ AccountCode: '225', Description: 'Basic', Quantity: 1, UnitAmount: 3900 }],
      Status: 'DRAFT',
      Type: 'ACCREC',
    })
    // PJ-56's lookups ran first, then a contact was created with the legacy code.
    const contact = xero.contacts.find((c) => c.ContactID === invoice!.Contact.ContactID)
    expect(contact).toMatchObject({ ContactNumber: 'AXI-4521', EmailAddress: 'accounts@brew.example.invalid', Name: 'Brew' })

    const saved = await readOrder(order.id)
    expect(saved.externalRefs).toEqual([
      expect.objectContaining({ externalId: invoice!.InvoiceID, provider: 'xero', url: null }),
    ])
    expect(saved.log.at(-1)).toMatchObject({ actor: 'system', event: 'external-ref', note: `xero ${invoice!.InvoiceID}` })
    expect(await syncRow(order.id)).toMatchObject({ attempts: 0, invoiceId: invoice!.InvoiceID, lastError: null, status: 'DRAFT' })
  })

  it('authorises the invoice when the order is invoiced, with the due date and the online link @S-102', async () => {
    const order = await createOrder(tenants.a, orgs.a)
    await setStatus(order.id, 'invoiced')

    const [invoice] = invoicesFor(order.id)
    expect(invoice).toMatchObject({ DueDate: '2026-12-05', Status: 'AUTHORISED' })

    const saved = await readOrder(order.id)
    const url = `https://in.xero.com/${invoice!.InvoiceID}`
    expect(saved.externalRefs).toEqual([expect.objectContaining({ externalId: invoice!.InvoiceID, provider: 'xero', url })])
    expect(saved.log.filter((entry: Doc) => entry.event === 'external-ref').map((entry: Doc) => entry.to)).toEqual([null, url])
    expect(await syncRow(order.id)).toMatchObject({ onlineUrl: url, status: 'AUTHORISED' })
  })

  it('does nothing in Xero when a re-run finds the invoice up to date @S-151', async () => {
    const order = await createOrder(tenants.a, orgs.a)
    await setStatus(order.id, 'invoiced')
    const calls = xero.calls.length

    await expect(syncXeroInvoice({ config, payload, sourceId: order.id })).resolves.toMatchObject({ action: 'unchanged' })
    await setStatus(order.id, 'paid')

    expect(xero.calls.length).toBe(calls)
    expect(invoicesFor(order.id)).toHaveLength(1)
  })

  it('keeps the order when Xero is down, queues a retry, and the retry invoices it once @S-151', async () => {
    xero.faults.push({ match: (call) => call.method === 'PUT' && call.path === '/Invoices', respond: unavailable })

    const order = await createOrder(tenants.a, orgs.a)
    expect(await readOrder(order.id)).toMatchObject({ externalRefs: [], status: 'pending' })
    expect(invoicesFor(order.id)).toHaveLength(0)
    expect(await syncRow(order.id)).toMatchObject({ attempts: 1, invoiceId: null })
    expect((await syncRow(order.id))?.lastError).toMatch(/^xero_unavailable/)

    const [job, ...more] = await queuedRetries(order.id)
    expect(more).toHaveLength(0)
    expect(job).toMatchObject({ queue: XERO_INVOICE_SYNC_QUEUE })

    await payload.jobs.run({ overrideAccess: true, queue: XERO_INVOICE_SYNC_QUEUE })

    expect(invoicesFor(order.id)).toHaveLength(1)
    expect((await readOrder(order.id)).externalRefs).toHaveLength(1)
    expect(await syncRow(order.id)).toMatchObject({ attempts: 0, lastError: null })
  })

  it('recovers an invoice whose answer was lost instead of creating a second one @S-151', async () => {
    // Xero creates the invoice, but the answer never arrives.
    xero.faults.push({ match: (call) => call.method === 'PUT' && call.path === '/Invoices', respond: networkError, when: 'after' })

    const order = await createOrder(tenants.a, orgs.a)
    expect(invoicesFor(order.id)).toHaveLength(1)
    expect((await readOrder(order.id)).externalRefs).toEqual([])

    await expect(syncXeroInvoice({ config, payload, sourceId: order.id })).resolves.toMatchObject({ action: 'updated' })

    const [invoice, ...duplicates] = invoicesFor(order.id)
    expect(duplicates).toHaveLength(0)
    expect((await readOrder(order.id)).externalRefs).toEqual([expect.objectContaining({ externalId: invoice!.InvoiceID })])
  })

  it('lets one of two concurrent runs create the invoice @S-151', async () => {
    const order = await createOrder(tenants.a, orgs.a, { status: 'waiting_for_purchase' })
    await quietStatus(order.id, 'pending')

    const results = await Promise.allSettled([
      syncXeroInvoice({ config, payload, sourceId: order.id }),
      syncXeroInvoice({ config, payload, sourceId: order.id }),
    ])

    expect(invoicesFor(order.id)).toHaveLength(1)
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(XeroInvoiceError)
        expect(result.reason.code).toBe('sync_in_progress')
      }
    }
    expect(results.some((result) => result.status === 'fulfilled' && result.value.action === 'created')).toBe(true)
  })

  it('never authorises an invoice whose Xero total differs, and does not retry it @S-151', async () => {
    const order = await createOrder(tenants.a, orgs.a)
    const [invoice] = invoicesFor(order.id)
    xero.totalOverride.set(invoice!.InvoiceID, 3800)

    await setStatus(order.id, 'invoiced')

    expect(invoicesFor(order.id)[0]).toMatchObject({ Status: 'DRAFT' })
    expect((await syncRow(order.id))?.lastError).toMatch(/^total_mismatch/)
    expect(await queuedRetries(order.id)).toHaveLength(0)
  })

  it('records a refusal from Xero and does not retry it @S-151', async () => {
    xero.faults.push({
      match: (call) => call.method === 'PUT' && call.path === '/Invoices',
      respond: () => rejected('Account code 225 is not a valid code'),
    })

    const order = await createOrder(tenants.a, orgs.a)

    expect((await syncRow(order.id))?.lastError).toMatch(/^xero_rejected: .*Account code 225/)
    expect(await queuedRetries(order.id)).toHaveLength(0)
    expect((await readOrder(order.id)).status).toBe('pending')
  })

  it('invoices each tenant in its own Xero organisation only @S-102', async () => {
    const order = await createOrder(tenants.b, orgs.b, { currency: 'VUV' })

    expect(invoicesFor(order.id, ORG_A)).toHaveLength(0)
    expect(invoicesFor(order.id, ORG_B)).toHaveLength(1)
    const calls = xero.calls.filter((call) => call.path.includes(`Order%20${order.id}`) || call.body?.Invoices?.[0]?.Reference === `Order ${order.id}`)
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map((call) => call.xeroTenantId))).toEqual(new Set([ORG_B]))
  })

  it('skips orders that need no invoice @S-102', async () => {
    const before = xero.calls.length

    const legacy = await createOrder(tenants.a, orgs.a, { legacyId: 9001, status: 'invoiced' })
    const request = await createOrder(tenants.a, orgs.a, { status: 'waiting_for_purchase' })
    const credit = await createOrder(tenants.a, orgs.a, { discount: 3900, paymentMethod: 'credit', paymentProvider: null, total: 0 })
    const switchedOff = await createOrder(tenants.off, orgs.off)

    expect(xero.calls.length).toBe(before)
    for (const order of [legacy, request, credit, switchedOff]) {
      expect(await syncRow(order.id)).toBeUndefined()
      expect((await readOrder(order.id)).externalRefs).toEqual([])
    }
  })
})
