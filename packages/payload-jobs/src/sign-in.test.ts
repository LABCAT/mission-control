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
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  superAdminAccess,
  tenantRoleOptions,
  END_USER_IP_HEADER,
  createMemoryRateLimiter,
  generateSignInCode,
  renewRollingSession,
  safeReturnPath,
  sessionSeconds,
  type RateLimiter,
  type SignInEmailDoc,
} from './index'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'sign_in_test'
const INSTANCE_KEY = 'sign-in-test'
const PASSWORD = 'correct horse battery'

const emails: { doc: SignInEmailDoc; event: string }[] = []
let failSend = false
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


const register = (tenant: Tenant, email: string) =>
  post(tenant, 'register', { email, firstName: 'Ada', password: PASSWORD })

const request = (tenant: Tenant, email: string, extra: object = {}, options: CallOptions = {}) =>
  post(tenant, 'sign-in/request', { email, turnstileToken: 'ok', ...extra }, options)

const verify = (tenant: Tenant, body: object, options: CallOptions = {}) =>
  post(tenant, 'sign-in/verify', body, options)

const password = (tenant: Tenant, email: string, extra: object = {}) =>
  post(tenant, 'login', { email, password: PASSWORD, ...extra })

const lastCode = (): string => {
  const code = /^\d{6}$/.exec(emails.at(-1)?.doc.code ?? '')?.[0]
  if (!code) throw new Error('no code was sent')

  return code
}

const lastLinkToken = (): string => new URL(emails.at(-1)!.doc.link).searchParams.get('token')!

const recordKeyOf = async (tenant: Tenant, email: string) =>
  `mc:sign-in:${await sha256Hex(`${tenant.id}:${email}`)}`

const sha256Hex = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const readRecord = async (tenant: Tenant, email: string) =>
  payload.kv.get<Record<string, any>>(await recordKeyOf(tenant, email))

const setTenantSessionDays = (tenant: Tenant, sessionDefaultDays: number, sessionKeepSignedInDays: number) =>
  payload.update({
    collection: 'tenants',
    data: { sessionDefaultDays, sessionKeepSignedInDays } as never,
    id: tenant.id,
    overrideAccess: true,
  })

describe('email sign-in (PJ-109)', () => {
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
          accountAuth: {
            rateLimiter: () => limiter,
            // The seam: a fake with the same shape as sendTemplate(event, doc).
            sendEmail: async (event, doc) => {
              if (failSend) throw new Error('mail is down')
              emails.push({ doc, event })
            },
            turnstile: {
              secret: () => 'test-secret-key',
              verify: async ({ token }) => ({ success: token === 'ok' }),
            },
          },
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
  })

  beforeEach(async () => {
    emails.length = 0
    failSend = false
    limiter = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 })
    await setTenantSessionDays(tenantA, 1, 30)
    await setTenantSessionDays(tenantB, 1, 30)
  })

  afterAll(async () => {
    if (!payload) return

    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  describe('requesting a code', () => {
    it('sends one email with a code and a link, and raises the sign-in event @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      const result = await request(tenantA, email)

      expect(result.status).toBe(202)
      expect(result.body).toEqual({ expiresInMinutes: 15, ok: true, resendAfterSeconds: 30 })
      expect(emails).toHaveLength(1)
      expect(emails[0]!.event).toBe('account.sign_in_code')
      expect(emails[0]!.doc.to).toBe(email)
      expect(emails[0]!.doc.code).toMatch(/^\d{6}$/)
      expect(emails[0]!.doc.link).toMatch(
        /^https:\/\/alpha\.example\.test\/account\/sign-in\/verify\?token=[a-f0-9]{64}$/,
      )
      expect(emails[0]!.doc.tenant.slug).toBe(tenantA.slug)
    })

    it('stores hashes only, never the code or the token', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)

      const stored = JSON.stringify(await readRecord(tenantA, email))

      expect(stored).not.toContain(lastCode())
      expect(stored).not.toContain(lastLinkToken())
    })

    it('answers the same for an unknown address and for a member of another tenant, and sends nothing', async () => {
      const outsider = await createUser({ tenant: tenantB })
      const known = await createUser({ tenant: tenantA })
      const real = await request(tenantA, known)
      emails.length = 0

      const unknown = await request(tenantA, newEmail('nobody'))
      const otherTenant = await request(tenantA, outsider)

      expect(unknown.status).toBe(real.status)
      expect(unknown.body).toEqual(real.body)
      expect(otherTenant.body).toEqual(real.body)
      expect(emails).toHaveLength(0)
    })

    it('does not tell the caller when the email could not be sent', async () => {
      const email = await createUser({ tenant: tenantA })
      failSend = true

      const result = await request(tenantA, email)

      expect(result.status).toBe(202)
    })

    it('refuses a bad address and a missing site key', async () => {
      expect((await request(tenantA, 'not-an-email')).body.error.code).toBe('invalid_request')
      expect((await request(tenantA, 'a@b.test', {}, { key: null })).body.error.code).toBe(
        'invalid_site_key',
      )
    })

    it('needs a passing Turnstile check and fails closed', async () => {
      const email = await createUser({ tenant: tenantA })

      const missing = await post(tenantA, 'sign-in/request', { email })
      const failed = await request(tenantA, email, { turnstileToken: 'bad' })

      expect(missing.body.error.code).toBe('turnstile_failed')
      expect(failed.body.error.code).toBe('turnstile_failed')
      expect(emails).toHaveLength(0)
    })

    it('is rate limited per visitor and per address @S-196', async () => {
      limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 })
      const email = await createUser({ tenant: tenantA })

      expect((await request(tenantA, email, {}, { ip: '203.0.113.1' })).status).toBe(202)
      expect((await request(tenantA, email, {}, { ip: '203.0.113.1' })).status).toBe(202)

      const blocked = await request(tenantA, email, {}, { ip: '203.0.113.1' })
      expect(blocked.status).toBe(429)
      expect(blocked.response.headers.get('retry-after')).toBe('60')

      // Another IP still counts against the address.
      expect((await request(tenantA, email, {}, { ip: '203.0.113.9' })).status).toBe(429)
    })

    it('does not send a second email within 30 seconds, then replaces the code after that @S-196', async () => {
      const email = await createUser({ tenant: tenantA })

      await request(tenantA, email)
      const first = lastCode()
      await request(tenantA, email)
      expect(emails).toHaveLength(1)

      const key = await recordKeyOf(tenantA, email)
      const record = (await readRecord(tenantA, email))!
      await payload.kv.set(key, { ...record, issuedAt: record.issuedAt - 31_000 })

      await request(tenantA, email)
      expect(emails).toHaveLength(2)
      expect((await verify(tenantA, { code: first, email })).body.error.code).toBe('invalid_code')
      expect((await verify(tenantA, { code: lastCode(), email })).status).toBe(200)
    })

    it('keeps a return path only when it stays on the site', async () => {
      const email = await createUser({ tenant: tenantA })

      await request(tenantA, email, { returnTo: '/account/saved-jobs?page=2' })
      expect(new URL(emails.at(-1)!.doc.link).searchParams.get('returnTo')).toBe(
        '/account/saved-jobs?page=2',
      )

      const key = await recordKeyOf(tenantA, email)
      const record = (await readRecord(tenantA, email))!
      await payload.kv.set(key, { ...record, issuedAt: 0 })

      await request(tenantA, email, { returnTo: 'https://evil.example/phish' })
      expect(new URL(emails.at(-1)!.doc.link).searchParams.has('returnTo')).toBe(false)
    })
  })

  describe('verifying a code or link', () => {
    it('signs in with the code and returns the session @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)

      const result = await verify(tenantA, { code: lastCode(), email })

      expect(result.status).toBe(200)
      expect(result.body.user).toMatchObject({ email, role: 'seeker' })
      expect(result.body.keepSignedIn).toBe(false)

      const me = await call('GET', tenantA.slug, 'me', { key: tenantA.key, token: result.body.token })
      expect(me.status).toBe(200)
      expect(me.body.user.email).toBe(email)
    })

    it('signs in with the link token, and the code from the same email stops working', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()

      const result = await verify(tenantA, { token: lastLinkToken() })

      expect(result.status).toBe(200)
      expect(result.body.user.email).toBe(email)
      expect((await verify(tenantA, { code, email })).body.error.code).toBe('invalid_code')
    })

    it('works once: the code and the link are both spent @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()
      const token = lastLinkToken()

      expect((await verify(tenantA, { code, email })).status).toBe(200)

      expect((await verify(tenantA, { code, email })).body.error.code).toBe('invalid_code')
      expect((await verify(tenantA, { token })).body.error.code).toBe('invalid_code')
    })

    it('refuses a code after 15 minutes @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()
      const token = lastLinkToken()

      const key = await recordKeyOf(tenantA, email)
      const record = (await readRecord(tenantA, email))!
      await payload.kv.set(key, { ...record, expiresAt: Date.now() - 1 })

      expect((await verify(tenantA, { code, email })).body.error.code).toBe('invalid_code')
      expect((await verify(tenantA, { token })).body.error.code).toBe('invalid_code')
    })

    it('spends the code after 5 wrong guesses, so it cannot be brute forced @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const right = lastCode()
      const wrong = right === '000000' ? '111111' : '000000'

      for (let attempt = 0; attempt < 5; attempt++) {
        expect((await verify(tenantA, { code: wrong, email })).body.error.code).toBe('invalid_code')
      }

      // Even the right code is refused now: the person has to ask for a new one.
      expect((await verify(tenantA, { code: right, email })).body.error.code).toBe('invalid_code')
      expect((await verify(tenantA, { token: lastLinkToken() })).body.error.code).toBe('invalid_code')
    })

    it('spends the code after 5 wrong guesses even when they arrive at the same moment @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const right = lastCode()
      const wrong = right === '000000' ? '111111' : '000000'

      const results = await Promise.all(
        Array.from({ length: 20 }, () => verify(tenantA, { code: wrong, email })),
      )
      expect(results.every((result) => result.status === 400)).toBe(true)

      // Twenty guesses against a cap of five: the right code no longer works.
      expect((await verify(tenantA, { code: right, email })).body.error.code).toBe('invalid_code')
    })

    it('lets only one of several simultaneous correct submissions sign in @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()

      const results = await Promise.all(Array.from({ length: 6 }, () => verify(tenantA, { code, email })))

      expect(results.filter((result) => result.status === 200)).toHaveLength(1)
      expect(results.filter((result) => result.status === 400)).toHaveLength(5)
    })

    it('lets only one of the code and the link win when both arrive together @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()
      const token = lastLinkToken()

      const results = await Promise.all([
        verify(tenantA, { code, email }),
        verify(tenantA, { token }),
        verify(tenantA, { code, email }),
        verify(tenantA, { token }),
      ])

      expect(results.filter((result) => result.status === 200)).toHaveLength(1)
    })

    it('keeps counting wrong guesses across new codes, so re-requesting does not reset the cap @S-196', async () => {
      const email = await createUser({ tenant: tenantA })
      let right = ''

      // Four rounds of 5 wrong guesses each = 20, the daily budget for one address on one site.
      for (let round = 0; round < 4; round++) {
        await request(tenantA, email)
        right = lastCode()
        const wrong = right === '000000' ? '111111' : '000000'
        for (let attempt = 0; attempt < 5; attempt++) await verify(tenantA, { code: wrong, email })

        // Make the next request count as a fresh code.
        const key = await recordKeyOf(tenantA, email)
        const record = await payload.kv.get<Record<string, any>>(key)
        if (record) await payload.kv.set(key, { ...record, issuedAt: 0 })
      }

      await request(tenantA, email)
      const fresh = lastCode()
      const refused = await verify(tenantA, { code: fresh, email })

      expect(refused.status).toBe(429)
      expect(refused.body.error.code).toBe('too_many_requests')

      // The link in the same email is unguessable, so it still works.
      expect((await verify(tenantA, { token: lastLinkToken() })).status).toBe(200)
    })

    it('still accepts the right code after fewer than 5 wrong guesses', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const right = lastCode()
      const wrong = right === '000000' ? '111111' : '000000'

      for (let attempt = 0; attempt < 4; attempt++) await verify(tenantA, { code: wrong, email })

      expect((await verify(tenantA, { code: right, email })).status).toBe(200)
    })

    it('limits verify requests per visitor and per address @S-196', async () => {
      limiter = createMemoryRateLimiter({ limit: 3, windowMs: 60_000 })
      const email = await createUser({ tenant: tenantA })

      const statuses: number[] = []
      for (let attempt = 0; attempt < 5; attempt++) {
        statuses.push((await verify(tenantA, { code: '123456', email }, { ip: '198.51.100.7' })).status)
      }

      expect(statuses).toEqual([400, 400, 400, 429, 429])
    })

    it("does not let a code or link work on another tenant, and does not spend it there", async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)
      const code = lastCode()
      const token = lastLinkToken()

      expect((await verify(tenantB, { code, email })).body.error.code).toBe('invalid_code')
      expect((await verify(tenantB, { token })).body.error.code).toBe('invalid_code')

      // Still good on its own tenant.
      expect((await verify(tenantA, { code, email })).status).toBe(200)
    })

    it('refuses a token index that points at a record whose own token is different', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)

      // A stale index, as a concurrent re-request could leave behind.
      const stale = 'a'.repeat(64)
      await payload.kv.set(`mc:sign-in-token:${await sha256Hex(`token:${stale}`)}`, {
        key: await recordKeyOf(tenantA, email),
      })

      expect((await verify(tenantA, { token: stale })).body.error.code).toBe('invalid_code')
      // The real record is untouched, and still works.
      expect((await verify(tenantA, { token: lastLinkToken() })).status).toBe(200)
    })

    it('rejects malformed input without a lookup', async () => {
      const email = await createUser({ tenant: tenantA })

      for (const body of [{}, { email }, { code: '12345', email }, { code: 'abcdef', email }, { token: 5 }]) {
        expect((await verify(tenantA, body)).body.error.code, JSON.stringify(body)).toBe('invalid_code')
      }
    })

    it('confirms an account that was never verified, because the code proves the address', async () => {
      const email = newEmail('unverified')
      await register(tenantA, email)

      expect((await password(tenantA, email)).body.error.code).toBe('email_not_verified')

      emails.length = 0
      await request(tenantA, email)
      expect((await verify(tenantA, { code: lastCode(), email })).status).toBe(200)
      expect((await password(tenantA, email)).status).toBe(200)
    })

    it('treats the address case-insensitively', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email.toUpperCase())

      expect((await verify(tenantA, { code: lastCode(), email: email.toUpperCase() })).status).toBe(200)
    })
  })

  describe('session length (S-080)', () => {
    it('lasts the default period when "Keep me signed in" is not ticked @S-080', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)

      const { body } = await verify(tenantA, { code: lastCode(), email })

      expect(body.expiresIn).toBe(86_400)
      expect(body.exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(86_400 - 60)
      expect(body.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(86_400)
    })

    it('lasts the longer period when it is ticked @S-080', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email, { keepSignedIn: true })

      const { body } = await verify(tenantA, { code: lastCode(), email })

      expect(body.keepSignedIn).toBe(true)
      expect(body.expiresIn).toBe(30 * 86_400)
    })

    it("reads both periods from the tenant's settings, per tenant @S-080", async () => {
      await setTenantSessionDays(tenantA, 2, 7)
      const a = await createUser({ tenant: tenantA })
      const b = await createUser({ tenant: tenantB })

      await request(tenantA, a)
      const unticked = await verify(tenantA, { code: lastCode(), email: a })
      await request(tenantA, a, { keepSignedIn: true })
      await payload.kv.set(await recordKeyOf(tenantA, a), {
        ...(await readRecord(tenantA, a))!,
        issuedAt: 0,
      })
      const ticked = await (async () => {
        await request(tenantA, a, { keepSignedIn: true })
        return verify(tenantA, { code: lastCode(), email: a })
      })()
      await request(tenantB, b)
      const other = await verify(tenantB, { code: lastCode(), email: b })

      expect(unticked.body.expiresIn).toBe(2 * 86_400)
      expect(ticked.body.expiresIn).toBe(7 * 86_400)
      expect(other.body.expiresIn).toBe(86_400)
    })

    it('applies to password sign-in too, and leaves one session behind @S-080', async () => {
      const email = await createUser({ tenant: tenantA })

      const unticked = await password(tenantA, email)
      const ticked = await password(tenantA, email, { keepSignedIn: true })

      expect(unticked.body.expiresIn).toBe(86_400)
      expect(ticked.body.expiresIn).toBe(30 * 86_400)

      const user = await payload.db.findOne({
        collection: 'users',
        where: { email: { equals: email } },
      })
      // Two sign-ins, two sessions: the two-hour session Payload's own login makes is dropped.
      expect((user as unknown as { sessions: unknown[] }).sessions).toHaveLength(2)
    })

    it('rolls a ticked session: renewed after a day, not before @S-080', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await password(tenantA, email, { keepSignedIn: true })

      const fresh = await call('GET', tenantA.slug, 'me', { key: tenantA.key, token: body.token })
      expect(fresh.body.session).toBeUndefined()

      const user = (await payload.db.findOne({
        collection: 'users',
        where: { email: { equals: email } },
      })) as { id: number }
      const later = Date.now() + 2 * 86_400_000
      const renewed = await renewRollingSession({
        now: later,
        payload,
        token: body.token,
        userID: user.id,
        usersSlug: 'users',
      })

      expect(renewed?.expiresIn).toBe(30 * 86_400)

      const stored = (await payload.db.findOne({
        collection: 'users',
        where: { email: { equals: email } },
      })) as unknown as { sessions: { expiresAt: string }[] }
      const furthest = Math.max(...stored.sessions.map(({ expiresAt }) => new Date(expiresAt).getTime()))
      expect(furthest).toBeGreaterThan(later + 29 * 86_400_000)
    })

    it('never renews longer than the tenant allows now @S-080', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await password(tenantA, email, { keepSignedIn: true })
      const user = (await payload.db.findOne({
        collection: 'users',
        where: { email: { equals: email } },
      })) as { id: number }

      const renewed = await renewRollingSession({
        maxSeconds: 7 * 86_400,
        now: Date.now() + 2 * 86_400_000,
        payload,
        token: body.token,
        userID: user.id,
        usersSlug: 'users',
      })

      expect(renewed?.expiresIn).toBe(7 * 86_400)
    })

    it('does not roll an unticked session @S-080', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await password(tenantA, email)
      const user = (await payload.db.findOne({
        collection: 'users',
        where: { email: { equals: email } },
      })) as { id: number }

      expect(
        await renewRollingSession({
          now: Date.now() + 5 * 86_400_000,
          payload,
          token: body.token,
          userID: user.id,
          usersSlug: 'users',
        }),
      ).toBeNull()
    })

    it('stops a session at sign-out, whatever its length', async () => {
      const email = await createUser({ tenant: tenantA })
      const { body } = await password(tenantA, email, { keepSignedIn: true })

      await call('POST', tenantA.slug, 'logout', { key: tenantA.key, token: body.token })

      const me = await call('GET', tenantA.slug, 'me', { key: tenantA.key, token: body.token })
      expect(me.status).toBe(401)
    })
  })

  describe('passwords stay an option', () => {
    it('upgrades a legacy WordPress hash on the first password sign-in @S-197', async () => {
      const email = await createUser({ tenant: tenantA })
      // A user imported from WordPress: no Payload hash yet, only the phpass one.
      await payload.db.updateOne({
        collection: 'users',
        data: {
          hash: null,
          legacyPasswordHash: '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0',
          salt: null,
          updatedAt: null,
        },
        returning: false,
        where: { email: { equals: email } },
      } as never)

      const result = await post(tenantA, 'login', { email, password: 'test12345', keepSignedIn: true })

      expect(result.status).toBe(200)
      expect(result.body.expiresIn).toBe(30 * 86_400)

      const { docs } = await payload.find({
        collection: 'users',
        depth: 0,
        overrideAccess: true,
        showHiddenFields: true,
        where: { email: { equals: email } },
      })
      expect((docs[0] as unknown as { legacyPasswordHash: null | string }).legacyPasswordHash).toBeNull()

      // The new hash works on its own.
      expect((await post(tenantA, 'login', { email, password: 'test12345' })).status).toBe(200)
    })

    it('lets a person with no password sign in by email @S-197', async () => {
      const email = await createUser({ tenant: tenantA })
      await request(tenantA, email)

      expect((await verify(tenantA, { code: lastCode(), email })).status).toBe(200)
    })
  })
})

describe('session length settings', () => {
  it('uses the legacy defaults when a tenant never set them @S-080', () => {
    expect(sessionSeconds({}, false)).toBe(86_400)
    expect(sessionSeconds({}, true)).toBe(30 * 86_400)
    expect(sessionSeconds(null, true)).toBe(30 * 86_400)
  })

  it('reads both settings and ignores values that make no sense @S-080', () => {
    expect(sessionSeconds({ sessionDefaultDays: 3, sessionKeepSignedInDays: 60 }, false)).toBe(3 * 86_400)
    expect(sessionSeconds({ sessionDefaultDays: 3, sessionKeepSignedInDays: 60 }, true)).toBe(60 * 86_400)
    expect(sessionSeconds({ sessionDefaultDays: 0, sessionKeepSignedInDays: -5 }, false)).toBe(86_400)
    expect(sessionSeconds({ sessionKeepSignedInDays: 99_999 }, true)).toBe(30 * 86_400)
    expect(sessionSeconds({ sessionKeepSignedInDays: Number.NaN }, true)).toBe(30 * 86_400)
  })
})

describe('safeReturnPath', () => {
  it('keeps a path on the same site', () => {
    expect(safeReturnPath('/account')).toBe('/account')
    expect(safeReturnPath('/jobs?x=1#top')).toBe('/jobs?x=1#top')
  })

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'account',
    '',
    '/a\nb',
    `/${'a'.repeat(600)}`,
    5,
    null,
  ])('refuses %j', (value) => {
    expect(safeReturnPath(value)).toBeNull()
  })
})

describe('generateSignInCode', () => {
  it('is always six digits', () => {
    for (let index = 0; index < 200; index++) expect(generateSignInCode()).toMatch(/^\d{6}$/)
  })
})
