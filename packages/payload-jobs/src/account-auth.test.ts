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
  accountUserHooks,
  adminPanelAccess,
  generateSiteKey,
  globalRoleOptions,
  isSuperAdmin,
  payloadJobs,
  superAdminAccess,
  tenantRoleOptions,
  END_USER_IP_HEADER,
  createMemoryRateLimiter,
  type RateLimiter,
} from './index'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'account_auth_test'
const INSTANCE_KEY = 'account-auth-test'
const PASSWORD = 'correct horse battery'

type Sent = { html: string; subject: string; to: string; from: unknown }

const sent: Sent[] = []
let limiter: RateLimiter = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 })

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
  access: { admin: adminPanelAccess },
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

const newEmail = (label: string) => `${label}-${++counter}-${runId}@example.invalid`

const createTenant = async (name: string, domain: string): Promise<Tenant> => {
  const slug = `${name}-${runId}`
  const tenant = (await payload.create({
    collection: 'tenants',
    data: {
      name,
      slug,
      domains: [{ domain }],
      // job-board settings added by the plugin
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
  email = newEmail('user'),
  role = 'seeker',
  tenant,
}: {
  email?: string
  role?: string
  tenant?: Tenant
}) => {
  await payload.create({
    collection: 'users',
    data: {
      email,
      password: PASSWORD,
      role: 'user',
      tenants: tenant ? [{ role, tenant: tenant.id }] : [],
    } as never,
    overrideAccess: true,
  })

  return email
}

type CallOptions = {
  body?: unknown
  ip?: string
  key?: null | string
  token?: string
}

const call = async (
  method: 'GET' | 'POST',
  tenant: string,
  action: string,
  { body, ip, key, token }: CallOptions = {},
) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (key) headers.set('x-site-key', key)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (ip) headers.set(END_USER_IP_HEADER, ip)

  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: INSTANCE_KEY,
    request: new Request(
      `http://localhost/api/tenants/${tenant}/account/${action}`,
      method === 'GET'
        ? { headers, method }
        : { body: body === undefined ? undefined : JSON.stringify(body), headers, method },
    ),
  })

  return { body: (await response.json()) as Record<string, any>, response, status: response.status }
}

const post = (tenant: Tenant, action: string, body: unknown, options: CallOptions = {}) =>
  call('POST', tenant.slug, action, { key: tenant.key, ...options, body })

const login = (tenant: Tenant, email: string, password = PASSWORD, options: CallOptions = {}) =>
  post(tenant, 'login', { email, password }, options)

const register = (tenant: Tenant, email: string, extra: object = {}) =>
  post(tenant, 'register', { email, firstName: 'Ada', password: PASSWORD, ...extra })

const forgot = (tenant: Tenant, email: string) => post(tenant, 'forgot-password', { email })

const reset = (tenant: Tenant, token: string, password: string) =>
  post(tenant, 'reset-password', { password, token })

/** The token in the last email's link. */
const lastToken = (): string => {
  const html = sent.at(-1)?.html ?? ''
  const match = /token=([a-f0-9]+)/.exec(html)
  if (!match) throw new Error(`no token in the last email: ${html}`)

  return match[1]!
}

describe('account auth endpoints', () => {
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
        sendEmail: async (message: any) => {
          sent.push(message)
        },
      }),
      plugins: [
        // Only auth here: the content features need a media collection and an editor.
        payloadJobs({
          accountAuth: { rateLimiter: () => limiter },
          features: { pages: false, siteSettings: false },
          tenancy: 'multi',
        }),
        multiTenantPlugin({
          collections: {},
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
  })

  beforeEach(() => {
    sent.length = 0
    limiter = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 })
  })

  afterAll(async () => {
    if (!payload) return

    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  describe('site key', () => {
    it('rejects a missing key on every endpoint', async () => {
      for (const [method, action] of [
        ['POST', 'login'],
        ['POST', 'logout'],
        ['GET', 'me'],
        ['POST', 'forgot-password'],
        ['POST', 'reset-password'],
        ['POST', 'register'],
        ['POST', 'verify-email'],
      ] as const) {
        const result = await call(method, tenantA.slug, action, {
          body: method === 'POST' ? {} : undefined,
        })

        expect(result.status, action).toBe(401)
        expect(result.body.error.code).toBe('invalid_site_key')
      }
    })

    it('rejects an unknown key', async () => {
      const email = await createUser({ tenant: tenantA })
      const result = await login(tenantA, email, PASSWORD, { key: 'sk_not-a-real-key' })

      expect(result.status).toBe(401)
      expect(result.body.error.code).toBe('invalid_site_key')
      expect(result.body.token).toBeUndefined()
    })

    it("rejects another tenant's key, even for a valid user", async () => {
      const email = await createUser({ tenant: tenantA })

      // The path names tenant A but the key belongs to tenant B.
      const result = await call('POST', tenantA.slug, 'login', {
        body: { email, password: PASSWORD },
        key: tenantB.key,
      })

      expect(result.status).toBe(403)
      expect(result.body.error.code).toBe('tenant_mismatch')
    })

    it('answers 404 for an unknown tenant', async () => {
      const result = await call('POST', 'no-such-tenant', 'login', {
        body: { email: 'a@b.co', password: PASSWORD },
        key: tenantA.key,
      })

      expect(result.status).toBe(404)
    })
  })

  describe('login, me and logout', () => {
    it('signs a member in and returns a token that me accepts', async () => {
      const email = await createUser({ tenant: tenantA })
      const result = await login(tenantA, email.toUpperCase())

      expect(result.status).toBe(200)
      expect(result.body.token).toEqual(expect.any(String))
      expect(result.body.expiresIn).toBeGreaterThan(0)
      expect(result.body.user).toMatchObject({ email, role: 'seeker' })
      expect(result.response.headers.get('set-cookie')).toBeNull()
      expect(result.response.headers.get('cache-control')).toBe('no-store')

      const me = await call('GET', tenantA.slug, 'me', {
        key: tenantA.key,
        token: result.body.token,
      })

      expect(me.status).toBe(200)
      expect(me.body.user).toMatchObject({ email, role: 'seeker' })
    })

    describe('WordPress legacy passwords (PJ-34)', () => {
      // A known phpass hash of this password, from the PJ-34 fixtures.
      const PHPASS = '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0'
      const WP_PASSWORD = 'test12345'

      const withLegacyHash = async (tenant: Tenant) => {
        const email = await createUser({ tenant })
        const id = (
          await payload.find({
            collection: 'users',
            overrideAccess: true,
            where: { email: { equals: email } },
          })
        ).docs[0]!.id

        await payload.db.updateOne({
          collection: 'users',
          // An imported WordPress user: a legacy hash and no Payload password yet.
          data: { hash: null, legacyPasswordHash: PHPASS, salt: null },
          returning: false,
          where: { id: { equals: id } },
        })

        const legacyHashOf = async () =>
          (
            (await payload.find({
              collection: 'users',
              overrideAccess: true,
              showHiddenFields: true,
              where: { id: { equals: id } },
            })) as { docs: { legacyPasswordHash?: null | string }[] }
          ).docs[0]!.legacyPasswordHash

        return { email, legacyHashOf }
      }

      it('signs in with the WordPress password through the endpoint and upgrades the hash', async () => {
        const { email, legacyHashOf } = await withLegacyHash(tenantA)

        expect(await legacyHashOf()).toBe(PHPASS)

        const first = await login(tenantA, email, WP_PASSWORD)
        expect(first.status).toBe(200)
        expect(first.body.token).toEqual(expect.any(String))
        expect(await legacyHashOf()).toBeNull()

        // Now an ordinary Payload user, and the old password still works.
        expect((await login(tenantA, email, WP_PASSWORD)).status).toBe(200)
        expect((await login(tenantA, email, 'wrong password')).status).toBe(401)
      })

      it('does not touch a legacy hash when the user signs in on the wrong tenant', async () => {
        const { email, legacyHashOf } = await withLegacyHash(tenantA)

        expect((await login(tenantB, email, WP_PASSWORD)).status).toBe(401)
        expect(await legacyHashOf()).toBe(PHPASS)
      })
    })

    it('rejects me without a token or with a bad one', async () => {
      expect((await call('GET', tenantA.slug, 'me', { key: tenantA.key })).status).toBe(401)
      expect(
        (await call('GET', tenantA.slug, 'me', { key: tenantA.key, token: 'garbage' })).status,
      ).toBe(401)
    })

    it('does not let a user from tenant A sign in on tenant B', async () => {
      const email = await createUser({ tenant: tenantA })

      const onB = await login(tenantB, email)
      expect(onB.status).toBe(401)
      expect(onB.body.token).toBeUndefined()

      // Indistinguishable from a wrong password, so B learns nothing about A's users.
      const wrong = await login(tenantB, email, 'not the password')
      expect(wrong.body).toEqual(onB.body)

      // They still sign in on their own tenant.
      expect((await login(tenantA, email)).status).toBe(200)
    })

    it("does not accept tenant A's token on tenant B", async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await login(tenantA, email)

      const me = await call('GET', tenantB.slug, 'me', { key: tenantB.key, token: body.token })

      expect(me.status).toBe(401)
    })

    it('signs in a user who is a member of both tenants on each', async () => {
      const email = await createUser({ tenant: tenantA })
      const user = await payload.find({
        collection: 'users',
        overrideAccess: true,
        where: { email: { equals: email } },
      })

      await payload.update({
        collection: 'users',
        data: {
          tenants: [
            { role: 'seeker', tenant: tenantA.id },
            { role: 'seeker', tenant: tenantB.id },
          ],
        } as never,
        id: user.docs[0]!.id,
        overrideAccess: true,
      })

      expect((await login(tenantA, email)).status).toBe(200)
      expect((await login(tenantB, email)).status).toBe(200)
    })

    it('keeps staff and users without a membership out of the site', async () => {
      const staff = await createUser({ role: 'tenant-admin', tenant: tenantA })
      const superAdmin = newEmail('super')

      await payload.create({
        collection: 'users',
        data: { email: superAdmin, password: PASSWORD, role: 'super-admin' } as never,
        overrideAccess: true,
      })

      expect((await login(tenantA, staff)).status).toBe(401)
      expect((await login(tenantA, superAdmin)).status).toBe(401)
    })

    it('lets an employer sign in', async () => {
      const email = await createUser({ role: 'employer', tenant: tenantA })
      const result = await login(tenantA, email)

      expect(result.status).toBe(200)
      expect(result.body.user.role).toBe('employer')
    })

    it('rejects a wrong password and an unknown email the same way', async () => {
      const email = await createUser({ tenant: tenantA })
      const wrong = await login(tenantA, email, 'wrong password')
      const unknown = await login(tenantA, newEmail('nobody'))

      expect(wrong.status).toBe(401)
      expect(unknown.status).toBe(401)
      expect(unknown.body).toEqual(wrong.body)
    })

    it('rejects a malformed body', async () => {
      expect((await post(tenantA, 'login', { email: 'x' })).status).toBe(401)
      expect((await post(tenantA, 'login', 'not an object')).status).toBe(400)
    })

    it('rejects an old token once the membership is removed or changes to a role that cannot sign in', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await login(tenantA, email)
      const asUser = { key: tenantA.key, token: body.token }
      const id = (
        await payload.find({
          collection: 'users',
          overrideAccess: true,
          where: { email: { equals: email } },
        })
      ).docs[0]!.id

      expect((await call('GET', tenantA.slug, 'me', asUser)).status).toBe(200)

      // Role change: the token's claims still say seeker, the database no longer allows it.
      await payload.update({
        collection: 'users',
        data: { tenants: [{ role: 'editor', tenant: tenantA.id }] } as never,
        id,
        overrideAccess: true,
      })
      expect((await call('GET', tenantA.slug, 'me', asUser)).status).toBe(401)

      // Membership restored, then removed altogether.
      await payload.update({
        collection: 'users',
        data: { tenants: [{ role: 'seeker', tenant: tenantA.id }] } as never,
        id,
        overrideAccess: true,
      })
      expect((await call('GET', tenantA.slug, 'me', asUser)).status).toBe(200)

      await payload.update({
        collection: 'users',
        data: { tenants: [] } as never,
        id,
        overrideAccess: true,
      })
      const removed = await call('GET', tenantA.slug, 'me', asUser)
      expect(removed.status).toBe(401)
      expect(removed.body.error.code).toBe('not_authenticated')
    })

    it('ends the session on logout', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await login(tenantA, email)
      const asUser = { key: tenantA.key, token: body.token }

      expect((await call('GET', tenantA.slug, 'me', asUser)).status).toBe(200)
      expect((await call('POST', tenantA.slug, 'logout', asUser)).status).toBe(200)
      expect((await call('GET', tenantA.slug, 'me', asUser)).status).toBe(401)
    })

    it('answers logout without a token, so a site can always clear its cookie', async () => {
      const result = await call('POST', tenantA.slug, 'logout', { key: tenantA.key })

      expect(result.status).toBe(200)
      expect(result.body).toEqual({ ok: true })
    })
  })

  describe('register and email verification', () => {
    it('creates an unverified seeker on the tenant and sends the verification email', async () => {
      const email = newEmail('seeker')
      const result = await register(tenantA, email)

      expect(result.status).toBe(202)
      expect(result.body).toEqual({ ok: true })

      const users = await payload.find({
        collection: 'users',
        depth: 0,
        overrideAccess: true,
        where: { email: { equals: email } },
      })
      const user = users.docs[0] as any

      expect(user).toMatchObject({ firstName: 'Ada', role: 'user' })
      expect(user.tenants).toHaveLength(1)
      expect(user.tenants[0]).toMatchObject({ role: 'seeker', tenant: tenantA.id })
      expect(user._verified).toBe(false)

      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({
        from: { address: 'jobs@alpha.example.test', name: 'alpha Jobs' },
        to: email,
      })
      expect(sent[0]!.html).toContain('https://alpha.example.test/account/verify-email?token=')
    })

    it('does not let an unverified seeker sign in, until they verify', async () => {
      const email = newEmail('seeker')
      await register(tenantA, email)

      const blocked = await login(tenantA, email)
      expect(blocked.status).toBe(403)
      expect(blocked.body.error.code).toBe('email_not_verified')
      expect(blocked.body.token).toBeUndefined()

      const verified = await post(tenantA, 'verify-email', { token: lastToken() })
      expect(verified.status).toBe(200)

      const result = await login(tenantA, email)
      expect(result.status).toBe(200)
      expect(result.body.user.role).toBe('seeker')
    })

    it('uses a verification token once', async () => {
      const email = newEmail('seeker')
      await register(tenantA, email)
      const token = lastToken()

      expect((await post(tenantA, 'verify-email', { token })).status).toBe(200)

      const again = await post(tenantA, 'verify-email', { token })
      expect(again.status).toBe(400)
      expect(again.body.error.code).toBe('invalid_token')
    })

    it("does not verify through another tenant's site", async () => {
      const email = newEmail('seeker')
      await register(tenantA, email)

      const result = await post(tenantB, 'verify-email', { token: lastToken() })
      expect(result.status).toBe(400)

      // Still unverified on its own tenant.
      expect((await login(tenantA, email)).status).toBe(403)
    })

    it('rejects an invalid token', async () => {
      expect((await post(tenantA, 'verify-email', { token: 'nope' })).status).toBe(400)
      expect((await post(tenantA, 'verify-email', {})).status).toBe(400)
    })

    it('answers the same for an address that is already registered', async () => {
      const email = await createUser({ tenant: tenantA })
      const fresh = await register(tenantA, newEmail('fresh'))
      sent.length = 0

      const existing = await register(tenantA, email)

      expect(existing.status).toBe(fresh.status)
      expect(existing.body).toEqual(fresh.body)
      expect(sent).toHaveLength(0)

      const users = await payload.find({
        collection: 'users',
        overrideAccess: true,
        where: { email: { equals: email } },
      })
      expect(users.totalDocs).toBe(1)
    })

    it('resends the link when an unverified seeker registers again', async () => {
      const email = newEmail('seeker')
      await register(tenantA, email)
      const first = lastToken()
      sent.length = 0

      expect((await register(tenantA, email)).status).toBe(202)

      expect(sent).toHaveLength(1)
      expect(lastToken()).toBe(first)
    })

    it('does not let a registration take over an account on another tenant', async () => {
      const email = await createUser({ tenant: tenantA })

      const result = await register(tenantB, email, { password: 'a different password' })

      expect(result.status).toBe(202)
      expect(sent).toHaveLength(0)
      expect((await login(tenantB, email, 'a different password')).status).toBe(401)
      expect((await login(tenantA, email)).status).toBe(200)
    })

    it('always creates a seeker, whatever the body says', async () => {
      const email = newEmail('sneaky')

      await register(tenantA, email, { role: 'super-admin', tenants: [{ tenant: tenantB.id }] })

      const user = (
        await payload.find({
          collection: 'users',
          depth: 0,
          overrideAccess: true,
          where: { email: { equals: email } },
        })
      ).docs[0] as any

      expect(user.role).toBe('user')
      expect(user.tenants).toHaveLength(1)
      expect(user.tenants[0]).toMatchObject({ role: 'seeker', tenant: tenantA.id })
    })

    it('rejects a bad email or a weak password', async () => {
      expect((await register(tenantA, 'not-an-email')).status).toBe(400)
      expect((await register(tenantA, newEmail('weak'), { password: 'short' })).status).toBe(400)
      expect(sent).toHaveLength(0)
    })

    it('creates users from the admin or scripts already verified', async () => {
      const email = await createUser({ role: 'editor', tenant: tenantA })
      const user = (
        await payload.find({
          collection: 'users',
          depth: 0,
          overrideAccess: true,
          where: { email: { equals: email } },
        })
      ).docs[0] as any

      expect(user._verified).toBe(true)
      // Payload's own verification email is switched off.
      expect(sent).toHaveLength(0)
    })
  })

  describe('forgot and reset password', () => {
    it('emails a reset link from the tenant sender and answers the same for unknown emails', async () => {
      const email = await createUser({ tenant: tenantA })

      const known = await forgot(tenantA, email)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ from: { address: 'jobs@alpha.example.test' }, to: email })
      expect(sent[0]!.html).toContain('https://alpha.example.test/account/reset-password?token=')

      sent.length = 0
      const unknown = await forgot(tenantA, newEmail('nobody'))

      expect(unknown.status).toBe(known.status)
      expect(unknown.body).toEqual(known.body)
      expect(sent).toHaveLength(0)
    })

    it('sends nothing to a user from another tenant', async () => {
      const email = await createUser({ tenant: tenantA })

      const result = await forgot(tenantB, email)

      expect(result.status).toBe(200)
      expect(sent).toHaveLength(0)
    })

    it('changes the password, and a reset token works once', async () => {
      const email = await createUser({ tenant: tenantA })
      await forgot(tenantA, email)
      const token = lastToken()

      const first = await reset(tenantA, token, 'a brand new password')
      expect(first.status).toBe(200)

      const again = await reset(tenantA, token, 'another password again')
      expect(again.status).toBe(400)
      expect(again.body.error.code).toBe('invalid_token')

      // Only the first reset took effect.
      expect((await login(tenantA, email, PASSWORD)).status).toBe(401)
      expect((await login(tenantA, email, 'another password again')).status).toBe(401)
      expect((await login(tenantA, email, 'a brand new password')).status).toBe(200)
    })

    it('signs out sessions that were open before the reset', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await login(tenantA, email)
      await forgot(tenantA, email)
      await reset(tenantA, lastToken(), 'a brand new password')

      const me = await call('GET', tenantA.slug, 'me', { key: tenantA.key, token: body.token })
      expect(me.status).toBe(401)
    })

    it("does not accept tenant A's reset token on tenant B", async () => {
      const email = await createUser({ tenant: tenantA })
      await forgot(tenantA, email)

      const result = await reset(tenantB, lastToken(), 'a brand new password')

      expect(result.status).toBe(400)
      expect((await login(tenantA, email, PASSWORD)).status).toBe(200)
    })

    it('rejects an invalid token and a weak password', async () => {
      expect((await reset(tenantA, 'nope', 'a brand new password')).status).toBe(400)

      const email = await createUser({ tenant: tenantA })
      await forgot(tenantA, email)
      const token = lastToken()

      expect((await reset(tenantA, token, 'short')).status).toBe(400)
      // A weak password does not use up the token.
      expect((await reset(tenantA, token, 'a brand new password')).status).toBe(200)
    })
  })

  describe('rate limits', () => {
    beforeEach(() => {
      limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 })
    })

    it('limits login by visitor IP', async () => {
      const email = await createUser({ tenant: tenantA })
      const statuses: number[] = []

      for (let attempt = 0; attempt < 5; attempt++) {
        statuses.push((await login(tenantA, email, 'wrong password', { ip: '203.0.113.5' })).status)
      }

      expect(statuses).toEqual([401, 401, 401, 429, 429])

      // Another visitor, signing in as someone else, is not affected.
      const otherEmail = await createUser({ tenant: tenantA })
      const other = await login(tenantA, otherEmail, PASSWORD, { ip: '203.0.113.6' })
      expect(other.status).toBe(200)
    })

    it('limits login by email even when the IP changes', async () => {
      const email = await createUser({ tenant: tenantA })
      const statuses: number[] = []

      for (let attempt = 0; attempt < 5; attempt++) {
        statuses.push(
          (await login(tenantA, email, 'wrong password', { ip: `198.51.100.${attempt}` })).status,
        )
      }

      expect(statuses).toEqual([401, 401, 401, 429, 429])
    })

    it('sets Retry-After on a limited request', async () => {
      const email = newEmail('x')
      for (let attempt = 0; attempt < 3; attempt++) await login(tenantA, email, PASSWORD, { ip: '1' })

      const limited = await login(tenantA, email, PASSWORD, { ip: '1' })

      expect(limited.status).toBe(429)
      expect(limited.response.headers.get('retry-after')).toBe('60')
    })

    it('limits register', async () => {
      const statuses: number[] = []

      for (let attempt = 0; attempt < 5; attempt++) {
        statuses.push(
          (
            await post(
              tenantA,
              'register',
              { email: newEmail('burst'), password: PASSWORD },
              { ip: '203.0.113.7' },
            )
          ).status,
        )
      }

      expect(statuses).toEqual([202, 202, 202, 429, 429])
    })

    it('limits forgot-password', async () => {
      const email = await createUser({ tenant: tenantA })
      const statuses: number[] = []

      for (let attempt = 0; attempt < 5; attempt++) {
        statuses.push((await post(tenantA, 'forgot-password', { email })).status)
      }

      expect(statuses).toEqual([200, 200, 200, 429, 429])
      // Only the requests inside the limit sent mail.
      expect(sent).toHaveLength(3)
    })

    it('counts tenants separately', async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        await login(tenantA, newEmail('x'), PASSWORD, { ip: '203.0.113.9' })
      }

      expect((await login(tenantA, newEmail('x'), PASSWORD, { ip: '203.0.113.9' })).status).toBe(429)
      expect((await login(tenantB, newEmail('x'), PASSWORD, { ip: '203.0.113.9' })).status).toBe(401)
    })
  })
})
