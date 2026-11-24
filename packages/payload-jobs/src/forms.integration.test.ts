import { postgresAdapter, sql } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import {
  buildConfig,
  getPayload,
  handleEndpoints,
  type Block,
  type CollectionConfig,
  type Payload,
  type SanitizedConfig,
} from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { authenticatedAccess, isSuperAdmin, superAdminAccess, tenantRoleOptions } from './access'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit'
import {
  FORM_HONEYPOT_FIELD,
  formEndpoints,
  purgeFormSubmissionsTask,
  PURGE_FORM_SUBMISSIONS_TASK,
  type FormEmail,
  formEmailSender,
  type TurnstileVerifier,
} from './forms'
import { generateSiteKey } from './site-keys'

/**
 * The public form submission endpoint and the retention task against a real Postgres. The
 * `forms` and `form-submissions` collections here are the shape the CMS gets from the Payload
 * form builder (that plugin's own tests cover its config); what is under test is this
 * package's endpoint, email sender and purge task.
 */

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'forms_endpoint_test'
const INSTANCE = 'forms-endpoint-test'

type Verified = { remoteIp: null | string; token: string }
let verified: Verified[] = []
const verifier: TurnstileVerifier = async ({ remoteIp, token }) => {
  verified.push({ remoteIp: remoteIp ?? null, token })

  return { success: token === 'good-token' }
}

const Tenants: CollectionConfig = {
  slug: 'tenants',
  access: { create: superAdminAccess, read: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
    { name: 'domains', type: 'array', fields: [{ name: 'domain', type: 'text' }] },
    { name: 'isAggregate', type: 'checkbox', defaultValue: false },
    { name: 'formRetentionDays', type: 'number', defaultValue: 90 },
    { name: 'adminEmail', type: 'text' },
    { name: 'emailFromAddress', type: 'text' },
    { name: 'emailFromName', type: 'text' },
  ],
  versions: false,
}

const SiteKeys: CollectionConfig = {
  slug: 'site-keys',
  access: { create: superAdminAccess, read: superAdminAccess },
  fields: [
    { name: 'label', type: 'text' },
    { name: 'tenant', type: 'relationship', relationTo: 'tenants', required: true },
    { name: 'keyHash', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email' },
  auth: true,
  access: { read: authenticatedAccess },
  fields: [
    {
      name: 'role',
      type: 'select',
      options: [
        { label: 'Super admin', value: 'super-admin' },
        { label: 'User', value: 'user' },
      ],
      saveToJWT: true,
    },
  ],
  versions: false,
}

const answerField = (name: string): Block => ({
  slug: name,
  fields: [
    { name: 'name', type: 'text' },
    { name: 'label', type: 'text' },
    { name: 'required', type: 'checkbox' },
  ],
})

const Forms: CollectionConfig = {
  slug: 'forms',
  access: { create: superAdminAccess, read: authenticatedAccess, update: superAdminAccess },
  fields: [
    { name: 'title', type: 'text', required: true },
    {
      name: 'fields',
      type: 'blocks',
      blocks: [answerField('text'), answerField('email'), answerField('textarea')],
    },
  ],
  versions: false,
}

const Submissions: CollectionConfig = {
  slug: 'form-submissions',
  access: {
    create: () => false,
    read: ({ req }) => Boolean(req.user),
    update: () => false,
  },
  fields: [
    { name: 'form', type: 'relationship', relationTo: 'forms', required: true },
    {
      name: 'submissionData',
      type: 'array',
      fields: [
        { name: 'field', type: 'text', required: true },
        { name: 'value', type: 'textarea', required: true },
      ],
    },
  ],
  versions: false,
}

type Tenant = { id: number; key: string; slug: string }

let payload: Payload
let config: SanitizedConfig
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let tenantA: Tenant
let tenantB: Tenant
let limiter: RateLimiter = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 })

const createTenant = async (name: string, retention: null | number): Promise<Tenant> => {
  const slug = `${name}-${runId}`
  const tenant = (await payload.create({
    collection: 'tenants',
    data: {
      name,
      slug,
      adminEmail: `admin@${slug}.example.test`,
      domains: [{ domain: `${slug}.example.test` }],
      emailFromAddress: `jobs@${slug}.example.test`,
      emailFromName: `${name} Jobs`,
      ...(retention === null ? {} : { formRetentionDays: retention }),
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

const createForm = (tenant: Tenant) =>
  payload.create({
    collection: 'forms',
    data: {
      fields: [
        { blockType: 'text', label: 'Your name', name: 'name', required: true },
        { blockType: 'email', label: 'Email', name: 'email', required: true },
        { blockType: 'textarea', label: 'Message', name: 'message', required: true },
      ],
      tenant: tenant.id,
      title: `Contact ${tenant.slug}`,
    } as never,
    overrideAccess: true,
  }) as Promise<{ id: number }>

type SubmitOptions = {
  form?: number | string
  honeypot?: string
  key?: null | string
  tenant: string
  token?: null | string
  values?: Record<string, unknown>
}

const submit = async ({
  form,
  honeypot,
  key,
  tenant,
  token = 'good-token',
  values = { email: 'ada@example.invalid', message: 'Hello', name: 'Ada' },
}: SubmitOptions) => {
  const headers = new Headers({ 'content-type': 'application/json' })
  const siteKey = key === undefined ? tenantA.key : key
  if (siteKey) headers.set('x-site-key', siteKey)

  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: INSTANCE,
    request: new Request(`http://localhost/api/tenants/${tenant}/forms/submit`, {
      body: JSON.stringify({
        form,
        turnstileToken: token,
        values,
        ...(honeypot === undefined ? {} : { [FORM_HONEYPOT_FIELD]: honeypot }),
      }),
      headers,
      method: 'POST',
    }),
  })

  return { body: (await response.json()) as Record<string, any>, response, status: response.status }
}

const submissions = () =>
  payload.find({
    collection: 'form-submissions',
    depth: 0,
    overrideAccess: true,
    pagination: false,
  })

beforeEach(async () => {
  if (!payload) return

  await payload.delete({
    collection: 'form-submissions',
    overrideAccess: true,
    where: { id: { exists: true } },
  })
})

describe('public form submissions @S-324', () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests',
      )
    }

    config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Tenants, SiteKeys, Forms, Submissions],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl!, max: 10 },
        push: true,
        schemaName: SCHEMA,
      }),
      editor: lexicalEditor(),
      plugins: [
        multiTenantPlugin({
          collections: { forms: {}, 'form-submissions': {} },
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

    payload = await getPayload({ config, key: INSTANCE })

    // The plugin attaches these to the tenants collection; attach them the same way here.
    const tenants = config.collections.find((collection) => collection.slug === 'tenants')!
    tenants.endpoints = [
      ...(Array.isArray(tenants.endpoints) ? tenants.endpoints : []),
      ...formEndpoints({
        rateLimiter: () => limiter,
        turnstile: { secret: () => 'test-secret', verify: verifier },
      }),
    ]

    tenantA = await createTenant('alpha', 90)
    tenantB = await createTenant('bravo', 0)
  })

  beforeEach(() => {
    verified = []
    limiter = createMemoryRateLimiter({ limit: 1000, windowMs: 60_000 })
  })

  it('stores one submission for the calling tenant and answers ok', async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, tenant: tenantA.slug })

    expect(result.body, JSON.stringify(result.body)).toEqual({ ok: true })
    expect(result.status).toBe(200)
    expect(result.response.headers.get('cache-control')).toBe('no-store')
    // The IP is not forwarded here, so Cloudflare checks the token alone.
    expect(verified).toEqual([{ remoteIp: null, token: 'good-token' }])

    const { docs } = await submissions()
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({
      submissionData: [
        { field: 'name', value: 'Ada' },
        { field: 'email', value: 'ada@example.invalid' },
        { field: 'message', value: 'Hello' },
      ],
      tenant: tenantA.id,
    })
  })

  it('accepts the submission but stores nothing when retention is 0 @S-322', async () => {
    const form = await createForm(tenantB)
    const result = await submit({ form: form.id, key: tenantB.key, tenant: tenantB.slug })

    expect(result.status).toBe(200)
    expect(result.body).toEqual({ ok: true })
    expect((await submissions()).docs).toHaveLength(0)
  })

  it('refuses a submission with no Turnstile token', async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, tenant: tenantA.slug, token: null })

    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('turnstile_failed')
    expect((await submissions()).docs).toHaveLength(0)
  })

  it('refuses a token Cloudflare rejects', async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, tenant: tenantA.slug, token: 'bad-token' })

    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('turnstile_failed')
    expect((await submissions()).docs).toHaveLength(0)
  })

  it('answers a filled honeypot like a success, without checking Turnstile or storing', async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, honeypot: 'http://spam', tenant: tenantA.slug })

    expect(result.status).toBe(202)
    expect(result.body).toEqual({ ok: true })
    expect(verified).toEqual([])
    expect((await submissions()).docs).toHaveLength(0)
  })

  it("404s another tenant's form, exactly as a form that does not exist", async () => {
    const formOfB = await createForm(tenantB)

    const other = await submit({ form: formOfB.id, tenant: tenantA.slug })
    expect(other.status).toBe(404)
    expect(other.body.error.code).toBe('form_not_found')

    const missing = await submit({ form: 999_999, tenant: tenantA.slug })
    expect(missing.status).toBe(404)
    expect(missing.body.error.code).toBe('form_not_found')

    expect((await submissions()).docs).toHaveLength(0)
  })

  it("refuses another tenant's site key", async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, key: tenantB.key, tenant: tenantA.slug })

    expect(result.status).toBe(403)
    expect(result.body.error.code).toBe('tenant_mismatch')
    expect((await submissions()).docs).toHaveLength(0)
  })

  it('refuses a request with no site key', async () => {
    const form = await createForm(tenantA)
    const result = await submit({ form: form.id, key: null, tenant: tenantA.slug })

    expect(result.status).toBe(401)
    expect(result.body.error.code).toBe('invalid_site_key')
  })

  it('names the missing required field', async () => {
    const form = await createForm(tenantA)
    const result = await submit({
      form: form.id,
      tenant: tenantA.slug,
      values: { email: 'ada@example.invalid', message: 'Hello' },
    })

    expect(result.status).toBe(400)
    expect(result.body.error.code).toBe('invalid_values')
    expect(result.body.error.message).toBe('Your name is required')
    expect((await submissions()).docs).toHaveLength(0)
  })

  it('keeps an answer that is not a field of the form out of the document', async () => {
    const form = await createForm(tenantA)
    await submit({
      form: form.id,
      tenant: tenantA.slug,
      values: { email: 'ada@example.invalid', message: 'Hello', name: 'Ada', tenant: tenantB.id },
    })

    const { docs } = await submissions()
    expect(docs[0]!.submissionData).toHaveLength(3)
    expect(docs[0]!.tenant).toBe(tenantA.id)
  })

  it('shares one rate-limit budget across a form, not one per form', async () => {
    limiter = createMemoryRateLimiter({ limit: 1, windowMs: 60_000 })
    const form = await createForm(tenantA)

    expect((await submit({ form: form.id, tenant: tenantA.slug })).status).toBe(200)
    const second = await submit({ form: form.id, tenant: tenantA.slug })

    expect(second.status).toBe(429)
    expect(second.response.headers.get('retry-after')).toBe('60')
  })
})

describe('form notification sender @S-324', () => {
  const email = (overrides: Partial<FormEmail> = {}): FormEmail => ({
    from: 'default@example.invalid',
    html: '<p>Hi</p>',
    replyTo: 'default@example.invalid',
    subject: 'New contact message',
    to: 'editor@example.invalid',
    ...overrides,
  })

  it("sends as the tenant that owns the submission, not the CMS default", async () => {
    const send = formEmailSender()
    const result = await send([email()], {
      data: { tenant: { id: tenantA.id } },
      req: { payload } as never,
    })

    expect(result[0]!.from).toBe('alpha Jobs <jobs@alpha-' + runId + '.example.test>')
  })

  it("falls back to the tenant's admin when the form names no recipient", async () => {
    const send = formEmailSender()
    const result = await send([email({ to: '' })], {
      data: { tenant: tenantA.id },
      req: { payload } as never,
    })

    expect(result[0]!.to).toBe(`admin@alpha-${runId}.example.test`)
  })

  it('leaves the emails alone when there is no tenant', async () => {
    const send = formEmailSender()
    const original = email()
    const result = await send([original], { data: {}, req: { payload } as never })

    expect(result).toEqual([original])
  })
})

describe('form submission retention @S-322', () => {
  const runPurge = () =>
    (
      purgeFormSubmissionsTask({ batchSize: 50 }).handler as (
        args: unknown,
      ) => Promise<{ output: { submissionsDeleted: number; tenantsChecked: number } }>
    )({ req: { payload } })

  const age = (id: number | string, days: number) =>
    payload.db.drizzle.execute(
      sql.raw(
        `UPDATE "${SCHEMA}"."form_submissions" SET created_at = now() - interval '${days} days' WHERE id = ${id}`,
      ),
    )

  it('is a scheduled task on the hourly queue', () => {
    const task = purgeFormSubmissionsTask()

    expect(task.slug).toBe(PURGE_FORM_SUBMISSIONS_TASK)
    expect(task.schedule?.[0]).toEqual({ cron: '0 30 3 * * *', queue: 'hourly' })
  })

  it('deletes a submission one day past the boundary and keeps one a day inside it', async () => {
    const form = await createForm(tenantA)
    const data = { form: form.id, submissionData: [], tenant: tenantA.id }
    const old = (await payload.create({
      collection: 'form-submissions',
      data: data as never,
      overrideAccess: true,
    })) as { id: number }
    const fresh = (await payload.create({
      collection: 'form-submissions',
      data: data as never,
      overrideAccess: true,
    })) as { id: number }

    // Tenant A keeps 90 days: 91 is out, 89 is in.
    await age(old.id, 91)
    await age(fresh.id, 89)

    const result = await runPurge()

    expect(result.output.submissionsDeleted).toBe(1)
    expect((await submissions()).docs.map((doc) => doc.id)).toEqual([fresh.id])
  })

  it("empties a tenant whose retention is 0, and leaves other tenants' submissions alone", async () => {
    const formA = await createForm(tenantA)
    const formB = await createForm(tenantB)
    const kept = (await payload.create({
      collection: 'form-submissions',
      data: { form: formA.id, submissionData: [], tenant: tenantA.id } as never,
      overrideAccess: true,
    })) as { id: number }
    await payload.create({
      collection: 'form-submissions',
      data: { form: formB.id, submissionData: [], tenant: tenantB.id } as never,
      overrideAccess: true,
    })

    const result = await runPurge()

    // B keeps nothing; A's fresh submission is inside its 90 days.
    expect(result.output.submissionsDeleted).toBe(1)
    expect((await submissions()).docs.map((doc) => doc.id)).toEqual([kept.id])
  })

  it('changes nothing on a second run', async () => {
    const form = await createForm(tenantA)
    await payload.create({
      collection: 'form-submissions',
      data: { form: form.id, submissionData: [], tenant: tenantA.id } as never,
      overrideAccess: true,
    })

    expect((await runPurge()).output.submissionsDeleted).toBe(0)
    expect((await runPurge()).output.submissionsDeleted).toBe(0)
    expect((await submissions()).docs).toHaveLength(1)
  })
})

afterAll(async () => {
  if (!payload) return

  await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
  await payload.destroy()
})
