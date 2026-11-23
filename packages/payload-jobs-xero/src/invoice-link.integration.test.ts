import { postgresAdapter, sql } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import {
  buildConfig,
  createPayloadRequest,
  getPayload,
  type CollectionConfig,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  getPayloadJobsRegistry,
  globalRoleOptions,
  isSuperAdmin,
  ORDERS_SLUG,
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  tenantRoleOptions,
} from '@mission-control/payload-jobs'
import {
  DEFAULT_INVOICES_SLUG,
  DEFAULT_SETTINGS_SLUG,
  generateEncryptionKey,
  resolveXeroInvoicing,
} from '@mission-control/payload-xero'

import { OrderInvoiceLink } from './components/OrderInvoiceLink'
import { InvoiceLinkError, orderInvoiceEndpoints, resolveOrderInvoiceLink } from './invoice-link'
import {
  ORDER_INVOICE_COMPONENT_PATH,
  orderInvoiceAdapter,
  payloadJobsXero,
  seedXeroSettings,
  xeroTenantCollections,
} from './index'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = `mc_test_invoice_link_${Math.random().toString(36).slice(2, 8)}`
const INSTANCE_KEY = `payload-jobs-xero-invoice-link-${SCHEMA}`
const ENCRYPTION_KEY = generateEncryptionKey()
const ONLINE_URL = 'https://in.xero.com/abc-123'

const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  fields: [
    { name: 'role', type: 'select', defaultValue: 'user', options: globalRoleOptions, required: true, saveToJWT: true },
    { name: 'organisation', type: 'relationship', relationTo: 'organisations' },
  ],
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

let payload: Payload
let config: ReturnType<typeof resolveXeroInvoicing>
const tenants: Record<'a' | 'b' | 'off', Doc> = {} as never
const orgs: Record<'a' | 'b' | 'bTenant' | 'off', Doc> = {} as never
const users: Record<string, Doc> = {}
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
      ...(organisation.id === orgs.a.id ? { plan: planA.id } : {}),
      status: 'invoiced',
      subtotal: 3900,
      tax: 0,
      tenant: tenant.id,
      total: 3900,
      ...extra,
    } as never,
    overrideAccess: true,
  })) as unknown as Doc

/**
 * The sync row as the Xero sync leaves it once the invoice is authorised. The order's own save
 * may already have created the row (the sync runs on create), so this updates it in place.
 */
const syncRow = async (orderID: number, tenant: Doc, data: Record<string, unknown> = {}): Promise<Doc> => {
  const fields = {
    invoiceId: 'abc-123',
    invoiceNumber: 'INV-0042',
    onlineUrl: ONLINE_URL,
    reference: `Order ${orderID}`,
    source: ORDERS_SLUG,
    sourceId: String(orderID),
    status: 'AUTHORISED',
    ...data,
  }
  const { docs } = await payload.find({
    collection: DEFAULT_INVOICES_SLUG as never,
    overrideAccess: true,
    where: { and: [{ source: { equals: ORDERS_SLUG } }, { sourceId: { equals: String(orderID) } }] },
  })

  return (docs[0]
    ? await payload.update({
        collection: DEFAULT_INVOICES_SLUG as never,
        data: fields as never,
        id: docs[0].id,
        overrideAccess: true,
      })
    : await payload.create({
        collection: DEFAULT_INVOICES_SLUG as never,
        data: { ...fields, tenant: tenant.id } as never,
        overrideAccess: true,
      })) as unknown as Doc
}

/** The admin's invoice link component, called as Payload's server renders it. */
const renderAdminLink = async (
  orderID: unknown,
  user: Doc | null,
): Promise<null | { props: Record<string, unknown>; type: unknown }> =>
  (await OrderInvoiceLink({ id: orderID, payload, user } as never)) as null | {
    props: Record<string, unknown>
    type: unknown
  }

const request = async (orderID: number, user: Doc | null, query: Record<string, unknown> = {}): Promise<Response> => {
  const endpoint = orderInvoiceEndpoints({
    config: { invoicesSlug: config.invoicesSlug, scope: 'tenant', settingsSlug: config.settingsSlug, tenantField: 'tenant' },
    registry: getPayloadJobsRegistry(payload.config as never),
  })[0]!
  const req = await createPayloadRequest({
    payload,
    req: { query, routeParams: { id: String(orderID) }, url: `http://localhost/api/orders/${orderID}/invoice` } as never,
    user: (user ?? null) as never,
  })

  return (await endpoint.handler(req as PayloadRequest)) as Response
}

describe('the order invoice link', () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests')
    process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = 'true'

    const xeroOptions = { xero: { oauth: { encryptionKey: ENCRYPTION_KEY } } }
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
          name: `${name} Jobs`,
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

    const org = async (t: Doc, name: string) =>
      (await payload.create({
        collection: 'organisations',
        data: { billingEmail: 'accounts@brew.example.invalid', name, slug: `${name.toLowerCase()}-${runId}`, tenant: t.id } as never,
        overrideAccess: true,
      })) as unknown as Doc
    orgs.a = await org(tenants.a, 'Brew')
    orgs.b = await org(tenants.a, 'Bank')
    orgs.off = await org(tenants.off, 'Quiet')
    orgs.bTenant = await org(tenants.b, 'Shop')

    planA = (await payload.create({
      collection: 'plans',
      data: { durationDays: 45, jobCredits: 1, key: 'basic', name: 'Basic', price: 3900, tenant: tenants.a.id } as never,
      overrideAccess: true,
    })) as unknown as Doc

    const seed = {
      accountCodes: { addOn: '226', discount: '227', plan: '225' },
      authorise: true,
      dueDays: 14,
      reconciliationAccountCode: null,
      trackingCategory: null,
    }
    for (const t of [tenants.a, tenants.b, tenants.off]) {
      await seedXeroSettings({ payload, seed, tenantID: t.id })
    }

    // The tenant's settings row carries the due date the fallback prints.
    for (const t of [tenants.a, tenants.b, tenants.off]) {
      const { docs } = await payload.find({
        collection: DEFAULT_SETTINGS_SLUG as never,
        overrideAccess: true,
        where: { tenant: { equals: t.id } },
      })
      await payload.update({
        collection: DEFAULT_SETTINGS_SLUG as never,
        data: { dueDays: 14 } as never,
        id: docs[0]!.id,
        overrideAccess: true,
      })
    }

    const user = async (label: string, data: Record<string, unknown>): Promise<Doc> =>
      (await payload.create({
        collection: 'users',
        data: {
          email: `${label}-${runId}@example.invalid`,
          password: 'test-password',
          role: 'user',
          ...data,
        } as never,
        overrideAccess: true,
      })) as unknown as Doc

    users.member = await user('member', {
      organisation: orgs.a.id,
      tenants: [{ role: 'employer', tenant: tenants.a.id }],
    })
    users.otherOrg = await user('other-org', {
      organisation: orgs.b.id,
      tenants: [{ role: 'employer', tenant: tenants.a.id }],
    })
    users.staff = await user('staff', { tenants: [{ role: 'tenant-admin', tenant: tenants.a.id }] })
    users.staffB = await user('staff-b', { tenants: [{ role: 'tenant-admin', tenant: tenants.b.id }] })
    users.seeker = await user('seeker', { tenants: [{ role: 'seeker', tenant: tenants.a.id }] })
    users.superAdmin = await user('super', { role: 'super-admin' })
  })

  afterAll(async () => {
    if (!payload) return
    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  describe('wiring', () => {
    it('adds the endpoint and the admin link to the orders collection @S-101', () => {
      const orders = payload.config.collections.find((collection) => collection.slug === ORDERS_SLUG)!
      const endpoints = Array.isArray(orders.endpoints) ? orders.endpoints : []
      expect(endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toContain('get /:id/invoice')

      const before = orders.admin?.components?.edit?.beforeDocumentControls
      expect(JSON.stringify(before)).toContain(ORDER_INVOICE_COMPONENT_PATH)
    })

    it('leaves the collection alone when the link is switched off @S-101', async () => {
      const base = await payloadJobs({ accountAuth: false, tenancy: 'multi' })({
        admin: { user: 'users' },
        collections: [Users, Tenants],
        secret: 'test-secret',
      } as never)
      const built = await payloadJobsXero({ orderInvoiceLink: false })(base)
      const orders = built.collections!.find((collection) => collection.slug === ORDERS_SLUG)!

      expect(orders.endpoints ?? []).toHaveLength(0)
      expect(JSON.stringify(orders.admin?.components ?? {})).not.toContain(ORDER_INVOICE_COMPONENT_PATH)
    })
  })

  describe('access', () => {
    it('lets the order’s organisation member open the HTML invoice @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)
      const response = await request(order.id, users.member)

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(response.headers.get('content-disposition')).toBe('inline; filename="invoice-order-${id}.html"'.replace('${id}', String(order.id)))
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
      const html = (await response.text()).replace(/\u00a0/g, ' ')
      expect(html).toContain('Basic')
      expect(html).toContain('VUV 3,900')
      expect(html).toContain('Brew')
      expect(html).not.toContain('<script')
    })

    it('lets a site manager of the order’s tenant open it @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      expect((await request(order.id, users.staff)).status).toBe(200)
      expect((await request(order.id, users.superAdmin)).status).toBe(200)
    })

    it('refuses another organisation, another tenant, a seeker and a signed-out caller @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      for (const user of [users.otherOrg, users.staffB, users.seeker]) {
        const response = await request(order.id, user)
        expect(response.status).toBe(404)
        // The same answer as an id that does not exist: nothing to probe.
        expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
      }

      const signedOut = await request(order.id, null)
      expect(signedOut.status).toBe(401)
      expect(await signedOut.json()).toMatchObject({ error: { code: 'not_signed_in' } })

      const missing = await request(order.id, users.member)
      expect(missing.status).toBe(200)
      expect((await request(9_999_999, users.member)).status).toBe(404)
    })

    it('answers not_found for another tenant’s order even to its own member @S-101', async () => {
      const order = await createOrder(tenants.b, orgs.bTenant)

      expect((await request(order.id, users.otherOrg)).status).toBe(404)
      expect((await request(order.id, users.staffB)).status).toBe(200)
    })
  })

  describe('the link', () => {
    it('redirects to Xero’s online invoice when the sync recorded one @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)
      await syncRow(order.id, tenants.a)

      const response = await request(order.id, users.member)
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toBe(ONLINE_URL)
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')

      const json = await request(order.id, users.member, { format: 'json' })
      expect(await json.json()).toEqual({ kind: 'xero', reference: `Order ${order.id}`, url: ONLINE_URL })
    })

    it('describes the HTML fallback as JSON, with its filename and total @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)
      await syncRow(order.id, tenants.a, { onlineUrl: null, status: 'DRAFT' })

      const response = await request(order.id, users.member, { format: 'json' })
      expect(await response.json()).toEqual({
        currency: 'VUV',
        filename: `invoice-order-${order.id}.html`,
        kind: 'html',
        reference: `Order ${order.id}`,
        total: 3900,
      })
    })

    it('downloads the HTML when asked, and serves it inline otherwise @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      const download = await request(order.id, users.member, { download: '1' })
      expect(download.headers.get('content-disposition')).toMatch(/^attachment; filename="invoice-order-\d+\.html"$/)

      const inline = await request(order.id, users.member)
      expect(inline.headers.get('content-disposition')).toMatch(/^inline;/)
    })

    it('prints the Xero invoice number and a due date 14 days out when the row has them @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)
      await syncRow(order.id, tenants.a, { onlineUrl: null, status: 'DRAFT' })

      const html = (await (await request(order.id, users.member)).text()).replace(/\u00a0/g, ' ')
      expect(html).toContain('INV-0042')
      // The order's own date, plus the tenant's due days.
      const created = new Date(order.createdAt as string)
      created.setUTCDate(created.getUTCDate() + 14)
      expect(html).toContain(created.toISOString().slice(0, 10))
    })

    it('answers no_invoice for an order that needs none, and for a site with Xero off @S-101', async () => {
      const held = await createOrder(tenants.a, orgs.a, { status: 'waiting_for_purchase' })
      const heldResponse = await request(held.id, users.member)
      expect(heldResponse.status).toBe(404)
      expect(await heldResponse.json()).toMatchObject({ error: { code: 'no_invoice' } })

      const free = await createOrder(tenants.a, orgs.a, { subtotal: 0, total: 0 })
      expect((await request(free.id, users.member)).status).toBe(404)

      // The tenant switched the Xero add-on off: its orders have no invoice to open.
      const quiet = await createOrder(tenants.off, orgs.off)
      const offResponse = await request(quiet.id, users.superAdmin)
      expect(await offResponse.json()).toMatchObject({ error: { code: 'no_invoice' } })
    })

    it('resolves the same link without HTTP, for the admin component @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      await expect(
        resolveOrderInvoiceLink({
          config: { invoicesSlug: config.invoicesSlug, scope: 'tenant', settingsSlug: config.settingsSlug, tenantField: 'tenant' },
          orderID: order.id,
          payload,
          registry: getPayloadJobsRegistry(payload.config as never),
          user: users.member as never,
        }),
      ).resolves.toMatchObject({ kind: 'html', reference: `Order ${order.id}`, total: 3900 })

      await expect(
        resolveOrderInvoiceLink({
          config: { invoicesSlug: config.invoicesSlug, scope: 'tenant', settingsSlug: config.settingsSlug, tenantField: 'tenant' },
          orderID: order.id,
          payload,
          registry: getPayloadJobsRegistry(payload.config as never),
          user: users.otherOrg as never,
        }),
      ).rejects.toSatisfy((error) => error instanceof InvoiceLinkError && error.code === 'not_found')
    })
  })

  describe('the admin link', () => {
    it('sends a Xero order to its online invoice in a new tab @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)
      await syncRow(order.id, tenants.a)

      const link = await renderAdminLink(order.id, users.member)
      expect(link).toMatchObject({ props: { href: ONLINE_URL, rel: 'noopener noreferrer', target: '_blank' }, type: 'a' })
    })

    it('sends a fallback order to the endpoint, and shows nothing when there is no invoice @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      const link = await renderAdminLink(order.id, users.member)
      expect(link).toMatchObject({ props: { href: `/api/orders/${order.id}/invoice` }, type: 'a' })

      const free = await createOrder(tenants.a, orgs.a, { subtotal: 0, total: 0 })
      expect(await renderAdminLink(free.id, users.member)).toBeNull()
    })

    it('shows nothing to someone who may not open the order, or before the document exists @S-101', async () => {
      const order = await createOrder(tenants.a, orgs.a)

      expect(await renderAdminLink(order.id, users.otherOrg)).toBeNull()
      expect(await renderAdminLink(order.id, null)).toBeNull()
      // A new document in the admin has no id yet.
      expect(await renderAdminLink(undefined, users.member)).toBeNull()
    })
  })
})
