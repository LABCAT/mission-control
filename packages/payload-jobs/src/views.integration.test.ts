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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMemoryRateLimiter, type RateLimiter } from './rate-limit'
import {
  generateSiteKey,
  isSuperAdmin,
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  superAdminAccess,
  tenantRoleOptions,
} from './index'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'job_views_test'
const INSTANCE_KEY = 'job-views-test'

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: superAdminAccess, read: superAdminAccess },
  fields: [
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

const Tenants: CollectionConfig = {
  slug: 'tenants',
  access: { create: superAdminAccess, read: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
    { name: 'isAggregate', type: 'checkbox', defaultValue: false },
  ],
  versions: false,
}

const Users: CollectionConfig = {
  slug: 'users',
  auth: true,
  fields: [{ name: 'role', type: 'select', defaultValue: 'user', options: [{ label: 'User', value: 'user' }] }],
  versions: false,
}

type Tenant = { id: number; key: string; slug: string }

let payload: Payload
let config: SanitizedConfig
let tenantA: Tenant
let tenantB: Tenant
let limiter: RateLimiter = createMemoryRateLimiter({ limit: 100, windowMs: 60_000 })
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const BROWSER =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'

const createTenant = async (name: string, timezone: string): Promise<Tenant> => {
  const tenant = (await payload.create({
    collection: 'tenants',
    data: {
      name,
      slug: `${name}-${runId}`,
      adminEmail: `admin@${name}.invalid`,
      currency: 'VUV',
      currencyMinorUnits: 0,
      defaultLocale: 'en',
      isAggregate: false,
      emailFromAddress: `jobs@${name}.invalid`,
      emailFromName: `${name} Jobs`,
      locales: [{ locale: 'en' }],
      taxLabel: 'VAT',
      timezone,
    } as never,
    overrideAccess: true,
  })) as unknown as { id: number }

  const { key, keyHash } = await generateSiteKey()
  await payload.create({ collection: 'site-keys', data: { keyHash, tenant: tenant.id }, overrideAccess: true })

  return { id: tenant.id, key, slug: `${name}-${runId}` }
}

const view = async ({
  id,
  ip = '203.0.113.7',
  key,
  userAgent = BROWSER,
}: {
  id: number | string
  ip?: string
  key?: null | string
  userAgent?: string
}) => {
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': userAgent })
  if (key) headers.set('x-site-key', key)
  headers.set('x-end-user-ip', ip)

  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: INSTANCE_KEY,
    request: new Request(`http://localhost/api/jobs/${id}/view`, { body: '{}', headers, method: 'POST' }),
  })

  return { body: (await response.json()) as Record<string, unknown>, status: response.status }
}

let orgCount = 0

const job = async (data: Record<string, unknown>): Promise<number> => {
  const label = ++orgCount
  const organisation = await payload.create({
    collection: 'organisations',
    data: { name: `Org ${label}`, slug: `org-${label}-${runId}`, tenant: tenantA.id } as never,
    overrideAccess: true,
  })
  const doc = (await payload.create({
    collection: 'jobs',
    data: { organisation: organisation.id, title: 'Chef', ...data } as never,
    overrideAccess: true,
  })) as { id: number }

  return doc.id
}

/** Seed counts the way the beacon does; a normal update cannot change `views`. */
const seedViews = async (id: number, data: { views?: number; viewDays?: { count: number; day: string }[] }) => {
  await payload.update({ collection: 'jobs', context: { jobViews: true }, data, id, overrideAccess: true })
}

const stored = async (id: number) =>
  (await payload.findByID({ collection: 'jobs', depth: 0, id, overrideAccess: true })) as Record<string, unknown>

describe('job view beacon @S-286', () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database before integration tests')
    }

    config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Tenants, SiteKeys],
      db: postgresAdapter({ pool: { connectionString: databaseUrl!, max: 10 }, push: true, schemaName: SCHEMA }),
      plugins: [
        payloadJobs({ accountAuth: false, jobViews: { rateLimiter: () => limiter }, tenancy: 'multi' }),
        multiTenantPlugin({
          collections: Object.fromEntries(PAYLOAD_JOBS_TENANT_COLLECTIONS.map((slug) => [slug, {}])),
          tenantsArrayField: {
            rowFields: [
              { name: 'role', type: 'select', required: true, options: tenantRoleOptions, saveToJWT: true },
            ],
          },
          tenantsSlug: 'tenants',
          userHasAccessToAllTenants: (user) => isSuperAdmin(user),
        }),
      ],
      secret: 'test-secret',
    })

    payload = await getPayload({ config, key: INSTANCE_KEY })
    tenantA = await createTenant('alpha', 'Pacific/Efate')
    tenantB = await createTenant('bravo', 'UTC')
  }, 120_000)

  afterAll(async () => {
    if (!payload) return

    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  it('counts a live job once, and answers the counts', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })
    await seedViews(id, { views: 4 })

    const first = await view({ id, key: tenantA.key })
    const second = await view({ id, key: tenantA.key, ip: '203.0.113.8' })

    expect(first.status).toBe(200)
    expect(first.body).toEqual({ today: 1, total: 5 })
    expect(second.body).toEqual({ today: 2, total: 6 })
    expect((await stored(id)).views).toBe(6)
    const days = (await stored(id)).viewDays as { count: number; day: string }[]
    expect(days).toHaveLength(1)
    expect(days[0]?.count).toBe(2)
  })

  it('takes the day from the tenant’s timezone', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })

    await view({ id, key: tenantA.key })

    const days = (await stored(id)).viewDays as { count: number; day: string }[]
    const efate = new Intl.DateTimeFormat('en-CA', {
      day: '2-digit',
      month: '2-digit',
      timeZone: 'Pacific/Efate',
      year: 'numeric',
    }).format(new Date())

    expect(days[0]?.day).toBe(efate)
  })

  it('ignores a bot: the counts come back but nothing changes', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })
    await seedViews(id, { views: 3 })

    const result = await view({ id, key: tenantA.key, userAgent: BOT })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ today: 0, total: 3 })
    expect((await stored(id)).views).toBe(3)
  })

  it('refuses a missing or unknown site key', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })

    expect((await view({ id, key: null })).status).toBe(401)
    const unknown = await view({ id, key: 'sk_not-a-real-key' })
    expect(unknown.status).toBe(401)
    expect(unknown.body.error).toBe('invalid_site_key')
    expect((await stored(id)).views).toBe(0)
  })

  it('never counts a job of another tenant', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })

    const result = await view({ id, key: tenantB.key })

    expect(result.status).toBe(404)
    expect((await stored(id)).views).toBe(0)
  })

  it('does not count an expired or unpublished job', async () => {
    const expired = await job({ expiresAt: new Date(Date.now() - 86_400_000).toISOString(), status: 'published', tenant: tenantA.id })
    const draft = await job({ status: 'draft', tenant: tenantA.id })

    expect((await view({ id: expired, key: tenantA.key })).status).toBe(404)
    expect((await view({ id: draft, key: tenantA.key })).status).toBe(404)
    expect((await stored(expired)).views).toBe(0)
    expect((await stored(draft)).views).toBe(0)
  })

  it('answers 404 for a job that does not exist', async () => {
    expect((await view({ id: 999_999, key: tenantA.key })).status).toBe(404)
  })

  it('stops counting once a visitor is over the limit, and keeps the counts', async () => {
    limiter = createMemoryRateLimiter({ limit: 2, windowMs: 60_000 })
    const id = await job({ status: 'published', tenant: tenantA.id })

    const first = await view({ id, key: tenantA.key, ip: '198.51.100.4' })
    const second = await view({ id, key: tenantA.key, ip: '198.51.100.4' })
    const third = await view({ id, key: tenantA.key, ip: '198.51.100.4' })

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429])
    expect(third.body).toEqual({ today: 2, total: 2 })
    expect((await stored(id)).views).toBe(2)

    // Another visitor still counts.
    const other = await view({ id, key: tenantA.key, ip: '198.51.100.5' })
    expect(other.body).toEqual({ today: 3, total: 3 })

    limiter = createMemoryRateLimiter({ limit: 100, windowMs: 60_000 })
  })

  it('keeps the counter writable only through the beacon', async () => {
    const id = await job({ status: 'published', tenant: tenantA.id })
    await seedViews(id, { views: 10 })

    await payload.update({ collection: 'jobs', data: { views: 99, viewDays: [{ count: 99, day: '2027-01-01' }] }, id, overrideAccess: true })

    expect((await stored(id)).views).toBe(10)
  })
})
