import { postgresAdapter, sql } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import {
  buildConfig,
  getPayload,
  handleEndpoints,
  type CollectionConfig,
  type Payload,
  type SanitizedConfig,
} from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  AUDIT_LOG_SLUG,
  accountUserHooks,
  adminPanelAccess,
  createMemoryRateLimiter,
  generateSiteKey,
  globalRoleOptions,
  isSuperAdmin,
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  signViewAsToken,
  superAdminAccess,
  tenantRoleOptions,
  VIEW_AS_CSRF_HEADER,
  VIEW_AS_TTL_SECONDS,
  viewAsIneligibleReason,
} from './index'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'view_as_test'
const INSTANCE_KEY = 'view-as-test'
const PASSWORD = 'correct horse battery'
const ORIGIN = 'http://localhost'

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: superAdminAccess, read: superAdminAccess },
  fields: [
    { name: 'label', type: 'text', required: true },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email' },
  access: { admin: adminPanelAccess, delete: superAdminAccess },
  auth: { verify: true },
  hooks: {
    beforeChange: [accountUserHooks.beforeChange],
    beforeOperation: [accountUserHooks.beforeOperation],
  },
  fields: [
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'user',
      options: globalRoleOptions,
      saveToJWT: true,
    },
    { name: 'firstName', type: 'text' },
    { name: 'lastName', type: 'text' },
  ],
  versions: false,
}

const Tenants: CollectionConfig = {
  slug: 'tenants',
  access: { create: superAdminAccess, read: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
    { name: 'domains', type: 'array', fields: [{ name: 'domain', type: 'text', required: true }] },
    { name: 'isAggregate', type: 'checkbox', defaultValue: false },
  ],
  versions: false,
}

type Tenant = { id: number; key: string; slug: string }

let payload: Payload
let config: SanitizedConfig
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let tenantA: Tenant
let tenantB: Tenant
let counter = 0
let adminToken: string
let adminID: number

const newEmail = (label: string) => `${label}-${++counter}-${runId}@example.invalid`

const createTenant = async (name: string, domain: string): Promise<Tenant> => {
  const slug = `${name}-${runId}`
  const tenant = (await payload.create({
    collection: 'tenants',
    data: {
      name,
      slug,
      domains: [{ domain }],
      currency: 'VUV',
      currencyMinorUnits: 0,
      timezone: 'Pacific/Efate',
      locales: [{ locale: 'en' }],
      defaultLocale: 'en',
      taxLabel: 'VAT',
      emailFromName: `${name} Jobs`,
      emailFromAddress: `jobs@${domain}`,
      adminEmail: `admin@${domain}`,
    } as never,
    overrideAccess: true,
  })) as unknown as { id: number }
  const { key, keyHash } = await generateSiteKey()

  await payload.create({
    collection: 'site-keys',
    data: { keyHash, label: name, tenant: tenant.id },
    overrideAccess: true,
  })

  return { id: tenant.id, key, slug }
}

const createUser = async ({
  memberships = [],
  role = 'user',
}: {
  memberships?: { role: string; tenant: Tenant }[]
  role?: 'super-admin' | 'user'
}) => {
  const email = newEmail(role === 'super-admin' ? 'admin' : 'user')
  const user = (await payload.create({
    collection: 'users',
    data: {
      email,
      firstName: 'Ada',
      lastName: 'Lovelace',
      password: PASSWORD,
      role,
      tenants: memberships.map((m) => ({ role: m.role, tenant: m.tenant.id })),
    } as never,
    overrideAccess: true,
  })) as unknown as { id: number }

  return { email, id: user.id }
}

const loginToken = async (email: string): Promise<string> => {
  const result = await payload.login({ collection: 'users', data: { email, password: PASSWORD } })

  return result.token as string
}

const request = async (
  method: string,
  path: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {},
) => {
  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: INSTANCE_KEY,
    request: new Request(`${ORIGIN}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      method,
    }),
  })
  const text = await response.text()

  return { body: text ? (JSON.parse(text) as Record<string, any>) : {}, response, status: response.status }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/** The admin's request: same-origin, JSON, with the CSRF header. */
const adminHeaders = (token = adminToken, extra: Record<string, string> = {}) => ({
  ...bearer(token),
  origin: ORIGIN,
  [VIEW_AS_CSRF_HEADER]: 'start',
  ...extra,
})

const start = (
  targetID: number | string,
  tenant: Tenant | string | number = tenantA,
  headers: Record<string, string> = adminHeaders(),
) =>
  request('POST', `/api/users/${targetID}/view-as`, {
    body: { tenant: typeof tenant === 'object' ? tenant.slug : tenant },
    headers,
  })

const account = (
  method: 'GET' | 'POST',
  tenant: Tenant,
  action: string,
  { body, token, key = tenant.key }: { body?: unknown; key?: null | string; token?: string } = {},
) =>
  request(method, `/api/tenants/${tenant.slug}/account/${action}`, {
    body: method === 'POST' ? (body ?? {}) : undefined,
    headers: { ...(key ? { 'x-site-key': key } : {}), ...(token ? bearer(token) : {}) },
  })

/** Start and redeem in one go: a view-as token for the target. */
const viewAs = async (targetID: number, tenant: Tenant = tenantA) => {
  const started = await start(targetID, tenant)
  expect(started.status, JSON.stringify(started.body)).toBe(200)

  const redeemed = await account('POST', tenant, 'view-as/redeem', { body: { code: started.body.code } })
  expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200)

  return { code: started.body.code as string, token: redeemed.body.token as string }
}

const auditRows = async (where: Record<string, unknown> = {}) =>
  (
    await payload.find({
      collection: AUDIT_LOG_SLUG as never,
      limit: 100,
      overrideAccess: true,
      sort: 'createdAt',
      where: where as never,
    })
  ).docs as unknown as {
    action: string
    actorID: string
    detail: Record<string, any>
    sessionID?: string
    targetID?: string
    tenantID?: string
  }[]

describe('view as user (PJ-119)', () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests',
      )
    }

    config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Tenants, SiteKeys],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl!, max: 10 },
        push: true,
        schemaName: SCHEMA,
      }),
      email: () => ({
        name: 'test',
        defaultFromAddress: 'default@example.invalid',
        defaultFromName: 'Default',
        sendEmail: async () => {},
      }),
      plugins: [
        payloadJobs({
          accountAuth: { rateLimiter: createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 }) },
          tenancy: 'multi',
        }),
        multiTenantPlugin({
          collections: Object.fromEntries(PAYLOAD_JOBS_TENANT_COLLECTIONS.map((slug) => [slug, {}])),
          tenantsArrayField: {
            rowFields: [
              {
                name: 'role',
                type: 'select',
                required: true,
                options: tenantRoleOptions,
                saveToJWT: true,
              },
            ],
          },
          tenantsSlug: 'tenants',
          userHasAccessToAllTenants: (user) => isSuperAdmin(user),
        }),
      ],
      secret: 'test-secret',
    })

    payload = await getPayload({ config, key: INSTANCE_KEY })
    tenantA = await createTenant('alpha', 'alpha.example.test')
    tenantB = await createTenant('bravo', 'bravo.example.test')

    const admin = await createUser({ role: 'super-admin' })
    adminID = admin.id
    adminToken = await loginToken(admin.email)
  })

  afterAll(async () => {
    if (!payload) return

    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  beforeEach(async () => {
    // A fresh admin session each test: the admin's own session must be untouched by everything below.
    const result = await payload.find({ collection: 'users', overrideAccess: true, where: { id: { equals: adminID } } })
    adminToken = await loginToken((result.docs[0] as unknown as { email: string }).email)
  })

  describe('who can start @S-156', () => {
    it('lets a super admin view as a seeker, returning a one-time code and never a token', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const result = await start(target.id)

      expect(result.status).toBe(200)
      expect(result.body.code).toEqual(expect.any(String))
      expect(result.body.token).toBeUndefined()
      expect(result.body.expiresIn).toBe(VIEW_AS_TTL_SECONDS)
      expect(result.body.startURL).toBe('https://alpha.example.test/account/view-as/start')
      expect(result.response.headers.get('cache-control')).toBe('no-store')
    })

    it('lets a super admin view as an employer', async () => {
      const target = await createUser({ memberships: [{ role: 'employer', tenant: tenantA }] })

      expect((await start(target.id)).status).toBe(200)
    })

    it('refuses a request with no session', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const result = await start(target.id, tenantA, { origin: ORIGIN, [VIEW_AS_CSRF_HEADER]: 'start' })

      expect(result.status).toBe(401)
    })

    it('refuses a tenant admin, an editor, an employer and a seeker', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })

      for (const role of ['tenant-admin', 'editor', 'employer', 'seeker']) {
        const actor = await createUser({ memberships: [{ role, tenant: tenantA }] })
        const token = await loginToken(actor.email)
        const result = await start(target.id, tenantA, adminHeaders(token))

        expect(result.status, role).toBe(403)
        expect(result.body.code).toBeUndefined()
      }

      expect(await auditRows({ action: { equals: 'view-as.start' }, targetID: { equals: String(target.id) } })).toEqual([])
    })

    it('refuses a former super admin whose session is older than the demotion', async () => {
      const actor = await createUser({ role: 'super-admin' })
      const token = await loginToken(actor.email)
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })

      await payload.update({ collection: 'users', data: { role: 'user' }, id: actor.id, overrideAccess: true })

      expect((await start(target.id, tenantA, adminHeaders(token))).status).toBe(403)
    })

    it('refuses to view as a super admin, as yourself, or as staff', async () => {
      const otherAdmin = await createUser({ role: 'super-admin' })
      const adminWhoIsAlsoMember = await createUser({
        memberships: [{ role: 'seeker', tenant: tenantA }],
        role: 'super-admin',
      })
      const tenantAdmin = await createUser({ memberships: [{ role: 'tenant-admin', tenant: tenantA }] })
      const editor = await createUser({ memberships: [{ role: 'editor', tenant: tenantA }] })
      const seekerWhoIsStaffElsewhere = await createUser({
        memberships: [
          { role: 'seeker', tenant: tenantA },
          { role: 'tenant-admin', tenant: tenantB },
        ],
      })

      for (const [label, id] of [
        ['super admin', otherAdmin.id],
        ['super admin who is also a seeker', adminWhoIsAlsoMember.id],
        ['myself', adminID],
        ['tenant admin', tenantAdmin.id],
        ['editor', editor.id],
        ['seeker who is staff on another tenant', seekerWhoIsStaffElsewhere.id],
      ] as const) {
        const result = await start(id)

        expect(result.status, label).toBe(403)
        expect(result.body.code, label).toBeUndefined()
      }
    })

    it('refuses a user with no account on the tenant, and an unknown user or tenant', async () => {
      const onlyOnB = await createUser({ memberships: [{ role: 'seeker', tenant: tenantB }] })

      expect((await start(onlyOnB.id, tenantA)).status).toBe(403)
      expect((await start(99999999)).status).toBe(404)
      expect((await start(onlyOnB.id, 'no-such-tenant')).status).toBe(404)
    })

    it('logs refused starts, with the reason', async () => {
      const tenantAdmin = await createUser({ memberships: [{ role: 'tenant-admin', tenant: tenantA }] })
      await start(tenantAdmin.id)

      const rows = await auditRows({ action: { equals: 'view-as.refused' }, targetID: { equals: String(tenantAdmin.id) } })

      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ actorID: String(adminID), detail: { reason: 'not_site_account' } })
    })

    it('reports ineligibility reasons from the pure check', () => {
      expect(viewAsIneligibleReason(null, 1)).toBe('not_found')
      expect(viewAsIneligibleReason({ id: 1, role: 'super-admin' }, 1)).toBe('super_admin')
      expect(viewAsIneligibleReason({ id: 1, role: 'user', tenants: [] }, 1)).toBe('not_site_account')
      expect(
        viewAsIneligibleReason({ id: 1, role: 'user', tenants: [{ role: 'seeker', tenant: 1 }, { role: 'editor', tenant: 2 }] }, 1),
      ).toBe('staff_account')
      expect(viewAsIneligibleReason({ id: 1, role: 'user', tenants: [{ role: 'employer', tenant: 1 }] }, 1)).toBeNull()
    })
  })

  describe('CSRF-safe start @S-156', () => {
    it('refuses a start that is not clearly from our own admin', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })

      for (const [label, headers] of [
        ['no origin', { ...adminHeaders(), origin: '' }],
        ['another origin', adminHeaders(adminToken, { origin: 'https://evil.example' })],
        ['no CSRF header', { ...bearer(adminToken), origin: ORIGIN }],
        ['wrong CSRF value', adminHeaders(adminToken, { [VIEW_AS_CSRF_HEADER]: 'yes' })],
        ['cross-site fetch', adminHeaders(adminToken, { 'sec-fetch-site': 'cross-site' })],
        ['same-site (subdomain) fetch', adminHeaders(adminToken, { 'sec-fetch-site': 'same-site' })],
        ['form content type', adminHeaders(adminToken, { 'content-type': 'application/x-www-form-urlencoded' })],
      ] as const) {
        const result = await start(target.id, tenantA, headers as Record<string, string>)

        expect(result.status, label).toBe(403)
        expect(result.body.error?.code, label).toBe('csrf')
      }
    })

    it('does not accept a GET', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const result = await request('GET', `/api/users/${target.id}/view-as`, { headers: adminHeaders() })

      expect(result.status).not.toBe(200)
      expect(result.body.code).toBeUndefined()
    })
  })

  describe('redeeming the code @S-157', () => {
    it('gives the site a token that me accepts, with the viewing flag and no secrets', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)

      const me = await account('GET', tenantA, 'me', { token })

      expect(me.status).toBe(200)
      expect(me.body.user).toMatchObject({ email: target.email, firstName: 'Ada', role: 'seeker' })
      expect(me.body.viewAs.expiresAt).toEqual(expect.any(String))
      expect(JSON.stringify(me.body)).not.toMatch(/hash|salt|password|token/i)
    })

    it('works once', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { code } = await viewAs(target.id)

      const again = await account('POST', tenantA, 'view-as/redeem', { body: { code } })

      expect(again.status).toBe(400)
      expect(again.body.token).toBeUndefined()
    })

    it('needs the site key of the tenant the code was issued for', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const started = await start(target.id)

      // Another tenant's site, with its own valid key, cannot redeem it, and doing so spends it.
      const onB = await account('POST', tenantB, 'view-as/redeem', { body: { code: started.body.code } })
      expect(onB.status).toBe(400)

      const noKey = await account('POST', tenantA, 'view-as/redeem', { body: { code: started.body.code }, key: null })
      expect(noKey.status).toBe(401)
    })

    it('rejects guessed, empty and expired codes', async () => {
      for (const code of ['', 'x'.repeat(43), undefined, 12345, 'a'.repeat(500)]) {
        expect((await account('POST', tenantA, 'view-as/redeem', { body: { code } })).status).toBe(400)
      }
    })

    it('rejects a code after its 60 seconds', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const started = await start(target.id)
      const real = Date.now
      Date.now = () => real() + 61_000

      try {
        expect((await account('POST', tenantA, 'view-as/redeem', { body: { code: started.body.code } })).status).toBe(400)
      } finally {
        Date.now = real
      }
    })
  })

  describe('the token @S-157', () => {
    it('is bound to its tenant', async () => {
      const target = await createUser({
        memberships: [
          { role: 'seeker', tenant: tenantA },
          { role: 'seeker', tenant: tenantB },
        ],
      })
      const { token } = await viewAs(target.id, tenantA)

      expect((await account('GET', tenantA, 'me', { token })).status).toBe(200)
      expect((await account('GET', tenantB, 'me', { token })).status).toBe(401)
    })

    it('is accepted as a Bearer header only, never as a cookie', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)

      const asCookie = await request('GET', `/api/tenants/${tenantA.slug}/account/me`, {
        headers: { cookie: `payload-token=${token}`, 'x-site-key': tenantA.key },
      })
      expect(asCookie.status).toBe(401)

      const asJWTScheme = await request('GET', `/api/tenants/${tenantA.slug}/account/me`, {
        headers: { authorization: `JWT ${token}`, 'x-site-key': tenantA.key },
      })
      expect(asJWTScheme.status).toBe(401)
    })

    it('is not a Payload JWT, so a normal sign-in session cannot be forged from it', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)
      const [prefix, claims] = token.split('.')

      // Tampered claims (a different user) fail the signature.
      const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(claims!, 'base64url').toString()), sub: adminID })).toString('base64url')
      const tampered = `${prefix}.${forged}.${token.split('.')[2]}`
      expect((await account('GET', tenantA, 'me', { token: tampered })).status).toBe(401)

      // Payload's own endpoints do not see a plain user: the marker is what the guards read.
      const auth = await payload.auth({ headers: new Headers(bearer(token)) })
      expect((auth.user as { _viewAs?: { by: number } } | null)?._viewAs?.by).toBe(adminID)
    })

    it('stops working at 30 minutes, with no refresh', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)
      const real = Date.now
      Date.now = () => real() + (VIEW_AS_TTL_SECONDS + 5) * 1000

      try {
        expect((await account('GET', tenantA, 'me', { token })).status).toBe(401)
      } finally {
        Date.now = real
      }

      expect((await account('GET', tenantA, 'me', { token })).status).toBe(200)
    })

    it('stops working when its session has expired in the database', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)
      const raw = (await payload.db.findOne({ collection: 'users', where: { id: { equals: target.id } } })) as any

      await payload.db.updateOne({
        collection: 'users',
        data: { ...raw, sessions: raw.sessions.map((s: any) => ({ ...s, expiresAt: new Date(Date.now() - 1000) })) },
        returning: false,
        where: { id: { equals: target.id } },
      })

      expect((await account('GET', tenantA, 'me', { token })).status).toBe(401)
    })

    it('stops working when a token is signed with an expiry in the past', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)
      const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())
      const expired = await signViewAsToken(payload.secret, { ...claims, exp: Math.floor(Date.now() / 1000) - 1 })

      expect((await account('GET', tenantA, 'me', { token: expired })).status).toBe(401)
    })

    it('stops working when the super admin is demoted, or the user becomes staff', async () => {
      const admin = await createUser({ role: 'super-admin' })
      const adminSession = await loginToken(admin.email)
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const started = await start(target.id, tenantA, adminHeaders(adminSession))
      const { body } = await account('POST', tenantA, 'view-as/redeem', { body: { code: started.body.code } })

      expect((await account('GET', tenantA, 'me', { token: body.token })).status).toBe(200)
      await payload.update({ collection: 'users', data: { role: 'user' }, id: admin.id, overrideAccess: true })
      expect((await account('GET', tenantA, 'me', { token: body.token })).status).toBe(401)

      const second = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(second.id)
      expect((await account('GET', tenantA, 'me', { token })).status).toBe(200)
      await payload.update({
        collection: 'users',
        data: { tenants: [{ role: 'seeker', tenant: tenantA.id }, { role: 'tenant-admin', tenant: tenantB.id }] } as never,
        id: second.id,
        overrideAccess: true,
      })
      expect((await account('GET', tenantA, 'me', { token })).status).toBe(401)
    })

    it('does not touch the super admin session', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)
      await account('POST', tenantA, 'view-as/exit', { token })

      const me = await request('GET', '/api/users/me', { headers: bearer(adminToken) })
      expect(me.body.user?.id).toBe(adminID)
    })
  })

  describe('exit @S-157', () => {
    it('revokes the session at once and is idempotent', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)

      expect((await account('POST', tenantA, 'view-as/exit', { token })).status).toBe(200)
      expect((await account('GET', tenantA, 'me', { token })).status).toBe(401)
      expect((await account('POST', tenantA, 'view-as/exit', { token })).status).toBe(200)
      expect((await account('POST', tenantA, 'view-as/exit', {})).status).toBe(200)
    })

    it('is what a normal logout does too', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const { token } = await viewAs(target.id)

      expect((await account('POST', tenantA, 'logout', { token })).status).toBe(200)
      expect((await account('GET', tenantA, 'me', { token })).status).toBe(401)
      expect(await auditRows({ action: { equals: 'view-as.exit' }, targetID: { equals: String(target.id) } })).toHaveLength(1)
    })

    it("does not sign out the target's own, real session", async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const own = await account('POST', tenantA, 'login', { body: { email: target.email, password: PASSWORD } })
      const { token } = await viewAs(target.id)
      await account('POST', tenantA, 'view-as/exit', { token })

      expect((await account('GET', tenantA, 'me', { token: own.body.token })).status).toBe(200)
    })

    it('does not exit a view on another tenant', async () => {
      const target = await createUser({
        memberships: [
          { role: 'seeker', tenant: tenantA },
          { role: 'seeker', tenant: tenantB },
        ],
      })
      const { token } = await viewAs(target.id, tenantA)
      await account('POST', tenantB, 'view-as/exit', { token })

      expect((await account('GET', tenantA, 'me', { token })).status).toBe(200)
    })
  })

  describe('blocked while viewing @S-158', () => {
    let target: { email: string; id: number }
    let token: string

    beforeEach(async () => {
      target = await createUser({ memberships: [{ role: 'employer', tenant: tenantA }] })
      token = (await viewAs(target.id)).token
    })

    it('changes to the email, password, role and memberships are refused', async () => {
      for (const data of [
        { email: 'new@example.invalid' },
        { password: 'a brand new password' },
        { role: 'super-admin' },
        { tenants: [{ role: 'tenant-admin', tenant: tenantA.id }] },
        { _verified: false },
        { firstName: 'Ok', email: 'sneaky@example.invalid' },
      ]) {
        const result = await request('PATCH', `/api/users/${target.id}`, { body: data, headers: bearer(token) })

        expect(result.status, JSON.stringify(data)).toBe(403)
      }

      const after = (await payload.findByID({ collection: 'users', id: target.id, overrideAccess: true })) as any
      expect(after.email).toBe(target.email)
      expect(after.role).toBe('user')
      expect(after.tenants).toHaveLength(1)
      expect((await payload.login({ collection: 'users', data: { email: target.email, password: PASSWORD } })).token).toBeTruthy()
    })

    it('a name change is allowed, because it is not a sign-in detail', async () => {
      const result = await request('PATCH', `/api/users/${target.id}`, { body: { firstName: 'Grace' }, headers: bearer(token) })

      expect(result.status).toBe(200)
    })

    it('deleting the account is refused', async () => {
      const result = await request('DELETE', `/api/users/${target.id}`, { headers: bearer(token) })

      expect(result.status).toBe(403)
      expect(await payload.findByID({ collection: 'users', id: target.id, overrideAccess: true })).toBeTruthy()
    })

    it('refreshing the token, forgot/reset password and creating users are refused', async () => {
      for (const [path, body] of [
        ['/api/users/refresh-token', {}],
        ['/api/users/forgot-password', { email: target.email }],
        ['/api/users/reset-password', { password: 'another password', token: 'x' }],
        ['/api/users/unlock', { email: target.email }],
        ['/api/users', { email: newEmail('new'), password: PASSWORD }],
      ] as const) {
        const result = await request('POST', path, { body, headers: bearer(token) })

        expect(result.status, path).toBe(403)
        expect(result.body.token, path).toBeUndefined()
      }

      // And the account endpoints: nobody registers or resets a password through a view.
      for (const action of ['forgot-password', 'reset-password', 'register', 'verify-email']) {
        const result = await account('POST', tenantA, action, { body: { email: target.email, password: PASSWORD, token: 'x' }, token })

        expect(result.status, action).toBe(403)
        expect(result.body.error.code).toBe('view_as_blocked')
      }
    })

    it('creating, changing or deleting an order is refused', async () => {
      const auth = await payload.auth({ headers: new Headers(bearer(token)) })
      const user = auth.user as never

      await expect(
        payload.create({ collection: 'orders' as never, data: {} as never, overrideAccess: true, user }),
      ).rejects.toMatchObject({ status: 403 })

      // Changing or deleting an existing order runs the same guards, so call them directly.
      const hooks = payload.collections.orders.config.hooks
      const req = { payload, t: ((key: string) => key) as never, user } as never

      await expect(hooks.beforeChange[0]!({ data: {}, operation: 'update', req } as never)).rejects.toMatchObject({ status: 403 })
      await expect(hooks.beforeDelete[0]!({ id: 1, req } as never)).rejects.toMatchObject({ status: 403 })
    })

    it('has no admin panel access, and no way to start another view', async () => {
      const auth = await payload.auth({ headers: new Headers(bearer(token)) })
      const adminAccess = payload.collections.users.config.access.admin as (args: any) => any

      expect(await adminAccess({ req: { payload, user: auth.user } })).toBe(false)

      const other = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const result = await start(other.id, tenantA, adminHeaders(token))
      expect(result.status).toBe(403)
    })

    it('cannot read the audit log, site keys or the super admin', async () => {
      for (const path of [`/api/${AUDIT_LOG_SLUG}`, '/api/site-keys', `/api/users/${adminID}`]) {
        const result = await request('GET', path, { headers: bearer(token) })

        expect(result.body.docs?.length ?? 0, path).toBe(0)
        expect(result.body.email, path).toBeUndefined()
      }
    })

    it('logs every blocked attempt, with the super admin as actor', async () => {
      await request('PATCH', `/api/users/${target.id}`, { body: { email: 'x@example.invalid' }, headers: bearer(token) })
      await request('DELETE', `/api/users/${target.id}`, { headers: bearer(token) })

      const rows = await auditRows({ action: { equals: 'view-as.blocked' }, targetID: { equals: String(target.id) } })

      expect(rows.map((row) => row.detail.blocked).sort()).toEqual(['users.delete', 'users.update'])
      expect(rows.every((row) => row.actorID === String(adminID))).toBe(true)
      expect(rows.find((row) => row.detail.blocked === 'users.update')?.detail.fields).toEqual(['email'])
    })
  })

  describe('audit log @S-159', () => {
    it('records start, redeem, writes and exit with the super admin id, and no secrets', async () => {
      const target = await createUser({ memberships: [{ role: 'employer', tenant: tenantA }] })
      const { code, token } = await viewAs(target.id)

      await request('PATCH', `/api/users/${target.id}`, { body: { firstName: 'Grace' }, headers: bearer(token) })
      await account('POST', tenantA, 'view-as/exit', { token })

      const rows = await auditRows({ targetID: { equals: String(target.id) } })

      expect(rows.map((row) => row.action)).toEqual(['view-as.start', 'view-as.redeem', 'view-as.update', 'view-as.exit'])
      expect(rows.every((row) => row.actorID === String(adminID) && row.tenantID === String(tenantA.id))).toBe(true)
      expect(new Set(rows.map((row) => row.sessionID)).size).toBe(1)
      expect(rows[2]!.detail).toMatchObject({ collection: 'users', id: target.id })

      const dump = JSON.stringify(rows)
      expect(dump).not.toContain(code)
      expect(dump).not.toContain(token)
    })

    it('is readable by super admins only', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      await start(target.id)

      const asAdmin = await request('GET', `/api/${AUDIT_LOG_SLUG}`, { headers: bearer(adminToken) })
      expect(asAdmin.status).toBe(200)
      expect(asAdmin.body.docs.length).toBeGreaterThan(0)

      for (const role of ['tenant-admin', 'editor', 'employer', 'seeker']) {
        const actor = await createUser({ memberships: [{ role, tenant: tenantA }] })
        const result = await request('GET', `/api/${AUDIT_LOG_SLUG}`, { headers: bearer(await loginToken(actor.email)) })

        expect(result.body.docs?.length ?? 0, role).toBe(0)
      }
    })

    it('is append only: nobody writes, changes or removes entries', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      await start(target.id)
      const [row] = (await payload.find({ collection: AUDIT_LOG_SLUG as never, limit: 1, overrideAccess: true })).docs as { id: number }[]

      const create = await request('POST', `/api/${AUDIT_LOG_SLUG}`, {
        body: { action: 'x', actorID: '1' },
        headers: bearer(adminToken),
      })
      const update = await request('PATCH', `/api/${AUDIT_LOG_SLUG}/${row!.id}`, { body: { action: 'x' }, headers: bearer(adminToken) })
      const remove = await request('DELETE', `/api/${AUDIT_LOG_SLUG}/${row!.id}`, { headers: bearer(adminToken) })

      expect([create.status, update.status, remove.status].every((status) => status >= 400)).toBe(true)
      await expect(
        payload.update({ collection: AUDIT_LOG_SLUG as never, data: { action: 'rewritten' } as never, id: row!.id, overrideAccess: true }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        payload.delete({ collection: AUDIT_LOG_SLUG as never, id: row!.id, overrideAccess: true }),
      ).rejects.toMatchObject({ status: 403 })
    })

    it('does not log anything for ordinary sessions', async () => {
      const target = await createUser({ memberships: [{ role: 'seeker', tenant: tenantA }] })
      const before = (await auditRows()).length
      const own = await account('POST', tenantA, 'login', { body: { email: target.email, password: PASSWORD } })
      await request('PATCH', `/api/users/${target.id}`, { body: { firstName: 'Own' }, headers: bearer(own.body.token) })

      expect((await auditRows()).length).toBe(before)
    })
  })
})
