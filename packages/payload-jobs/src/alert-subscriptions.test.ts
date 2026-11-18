import type { AccessArgs, CollectionConfig, Field, TextField } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ALERT_READER_ROLES,
  ALERT_SUBSCRIPTIONS_SLUG,
  ALERT_TOKEN_PATTERN,
  alertSubscriptionCollection,
  generateAlertToken,
  normalizeAlertEmail,
  normalizeAlertKeywords,
  uniqueAlertEmailPerTenant,
} from './alert-subscriptions'
import type { MissionControlUser } from './access'
import { payloadJobs } from './index'
import { locationsCollection } from './collections/locations'
import { taxonomyCollections } from './taxonomies'
import { bootTestPayload, type TestHarness, type TestUser } from './test'

const fieldNamed = (collection: CollectionConfig, name: string): Field => {
  const field = collection.fields.find((candidate) => 'name' in candidate && candidate.name === name)
  if (!field) throw new Error(`${collection.slug} is missing ${name}`)
  return field
}

const userWith = (
  tenants: { role: 'editor' | 'employer' | 'seeker' | 'tenant-admin'; tenant: number }[],
  role: 'super-admin' | 'user' = 'user',
): MissionControlUser => ({ id: 1, role, tenants })

const relationshipID = (value: number | { id: number | string }): number | string =>
  typeof value === 'object' ? value.id : value

const argsFor = (user: MissionControlUser | null, data?: Record<string, unknown>) =>
  ({ data, req: { user } }) as unknown as AccessArgs

/** Payload's top-level message is generic, so assert on the per-field messages. */
const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

describe('alert subscription collection config', () => {
  const collection = alertSubscriptionCollection()

  it('is registered by the plugin and can be switched off', async () => {
    const baseConfig = {
      collections: [{ slug: 'users', fields: [] }],
      secret: 'test',
    } as never

    const on = await payloadJobs()(baseConfig)
    expect(on.collections?.map((candidate) => candidate.slug)).toContain(ALERT_SUBSCRIPTIONS_SLUG)

    const off = await payloadJobs({ features: { alerts: false } })(baseConfig)
    expect(off.collections?.map((candidate) => candidate.slug)).not.toContain(
      ALERT_SUBSCRIPTIONS_SLUG,
    )
  })

  it('has the fields the task asks for, plus legacyId for the importer', () => {
    expect(collection.fields.map((field) => ('name' in field ? field.name : field.type))).toEqual([
      'email',
      'confirmed',
      'confirmToken',
      'manageToken',
      'keywords',
      'categories',
      'types',
      'locations',
      'lastSentAt',
      'legacyId',
    ])

    expect(fieldNamed(collection, 'email')).toMatchObject({ required: true, type: 'email' })
    expect(fieldNamed(collection, 'confirmed')).toMatchObject({
      defaultValue: false,
      index: true,
      type: 'checkbox',
    })
    expect(fieldNamed(collection, 'categories')).toMatchObject({
      hasMany: true,
      relationTo: 'job-categories',
      type: 'relationship',
    })
    expect(fieldNamed(collection, 'types')).toMatchObject({
      hasMany: true,
      relationTo: 'job-types',
    })
    expect(fieldNamed(collection, 'locations')).toMatchObject({
      hasMany: true,
      relationTo: 'locations',
    })
    expect(fieldNamed(collection, 'lastSentAt')).toMatchObject({ type: 'date' })
    expect(fieldNamed(collection, 'legacyId')).toMatchObject({ index: true, type: 'number' })
  })

  it('never reads the tokens back over the API', () => {
    for (const name of ['confirmToken', 'manageToken'] as const) {
      expect(fieldNamed(collection, name)).toMatchObject({
        index: true,
        type: 'text',
        unique: true,
      })

      const read = (fieldNamed(collection, name) as TextField).access?.read
      expect(read?.({} as never)).toBe(false)
    }
  })

  it('is unique per tenant in multi-tenant mode, and per address when unscoped', () => {
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'email'], unique: true }])
    expect(fieldNamed(collection, 'email')).toMatchObject({ unique: false })

    const single = alertSubscriptionCollection({ tenantScoped: false })
    expect(single.indexes).toEqual([])
    expect(fieldNamed(single, 'email')).toMatchObject({ index: true, unique: true })
  })

  it('skips versions so Payload does not create _v tables', () => {
    expect(collection.versions).toBe(false)
  })
})

describe('alert subscription tokens', () => {
  it('mints 32-byte URL-safe tokens that pass the field validator', () => {
    const token = generateAlertToken()

    expect(token).toMatch(ALERT_TOKEN_PATTERN)
    expect(new Set(Array.from({ length: 20 }, generateAlertToken)).size).toBe(20)
  })

  it('rejects a token that is not URL-safe base64 of the right length', () => {
    const validate = (fieldNamed(alertSubscriptionCollection(), 'manageToken') as TextField)
      .validate as (value: unknown) => string | true

    expect(validate(undefined)).toBe(true)
    expect(validate(generateAlertToken())).toBe(true)
    expect(validate('short')).toMatch(/43 URL-safe/)
    expect(validate('a'.repeat(43) + '!')).toMatch(/43 URL-safe/)
  })
})

describe('alert subscription normalization', () => {
  it('lowercases and trims the address so one person has one subscription', () => {
    expect(normalizeAlertEmail('  Seeker@Example.INVALID ')).toBe('seeker@example.invalid')
    expect(normalizeAlertEmail('')).toBeNull()
    expect(normalizeAlertEmail(undefined)).toBeNull()
  })

  it('collapses whitespace in keywords and treats blank as no filter', () => {
    expect(normalizeAlertKeywords('  nurse   pacific ')).toBe('nurse pacific')
    expect(normalizeAlertKeywords('   ')).toBeNull()
  })
})

describe('alert subscription access control', () => {
  const collection = alertSubscriptionCollection()
  const read = collection.access?.read
  const create = collection.access?.create
  const update = collection.access?.update
  const remove = collection.access?.delete
  if (!read || !create || !update || !remove) throw new Error('Missing alert access functions')

  it('lets tenant admins read only their own tenants', async () => {
    expect(await read(argsFor(userWith([{ role: 'tenant-admin', tenant: 10 }])))).toEqual({
      tenant: { in: [10] },
    })
    expect(await read(argsFor(userWith([], 'super-admin')))).toBe(true)
    expect([...ALERT_READER_ROLES]).toEqual(['tenant-admin'])
  })

  it('keeps the subscriber list away from everyone else', async () => {
    expect(await read(argsFor(userWith([{ role: 'editor', tenant: 10 }])))).toBe(false)
    expect(await read(argsFor(userWith([{ role: 'employer', tenant: 10 }])))).toBe(false)
    expect(await read(argsFor(userWith([{ role: 'seeker', tenant: 10 }])))).toBe(false)
    expect(await read(argsFor(userWith([])))).toBe(false)
    expect(await read(argsFor(null))).toBe(false)
  })

  it('lets nobody change a subscription over the API: the token endpoints do', async () => {
    for (const access of [create, update, remove]) {
      expect(await access(argsFor(userWith([], 'super-admin')))).toBe(false)
      expect(await access(argsFor(userWith([{ role: 'tenant-admin', tenant: 10 }])))).toBe(false)
      expect(await access(argsFor(null))).toBe(false)
    }
  })

  it('has no tenant memberships to scope by in single-tenant mode, so only super admins read', async () => {
    const single = alertSubscriptionCollection({ tenantScoped: false })
    const singleRead = single.access?.read
    if (!singleRead) throw new Error('Missing read access')

    expect(await singleRead(argsFor(userWith([], 'super-admin')))).toBe(true)
    expect(await singleRead(argsFor(userWith([{ role: 'tenant-admin', tenant: 10 }])))).toBe(false)
  })
})

const requestWith = (docs: { id: number }[]) => {
  const find = vi.fn(async () => ({ docs }))
  return { find, req: { payload: { find } } as never }
}

describe('unique address per tenant hook', () => {
  const hook = uniqueAlertEmailPerTenant(true)

  it('looks the address up lowercased inside the tenant', async () => {
    const { find, req } = requestWith([])

    await expect(
      hook({ data: { email: ' Seeker@Example.invalid ', tenant: 10 }, req } as never),
    ).resolves.toEqual({ email: ' Seeker@Example.invalid ', tenant: 10 })

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        overrideAccess: true,
        where: {
          and: [{ email: { equals: 'seeker@example.invalid' } }, { tenant: { equals: 10 } }],
        },
      }),
    )
  })

  it('rejects an address already subscribed in the same tenant', async () => {
    const { req } = requestWith([{ id: 7 }])

    const error = await hook({
      data: { email: 'seeker@example.invalid', tenant: 10 },
      req,
    } as never).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      data: {
        errors: [
          { message: 'seeker@example.invalid is already subscribed on this site', path: 'email' },
        ],
      },
    })
  })

  it('lets a document keep its own address and skips the lookup without one', async () => {
    const { find, req } = requestWith([{ id: 7 }])

    await expect(
      hook({
        data: { email: 'seeker@example.invalid' },
        originalDoc: { id: 7, tenant: 10 },
        req,
      } as never),
    ).resolves.toEqual({ email: 'seeker@example.invalid' })

    await expect(hook({ data: { tenant: 10 }, req } as never)).resolves.toEqual({ tenant: 10 })
    expect(find).toHaveBeenCalledTimes(1)
  })

  it('does not scope by tenant when the collection is not tenant-scoped', async () => {
    const { find, req } = requestWith([])

    await uniqueAlertEmailPerTenant(false)({
      data: { email: 'seeker@example.invalid' },
      req,
    } as never)

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: 'seeker@example.invalid' } } }),
    )
  })
})

const taxonomies = (): CollectionConfig[] => [
  ...taxonomyCollections({ tenantScoped: true }),
  locationsCollection({ requireTenant: true }),
]

describe('alert subscriptions integration', () => {
  let harness: TestHarness
  let employerA: TestUser
  let editorA: TestUser
  let seekerA: TestUser

  const makeUser = async (label: string, tenants: TestUser['tenants']): Promise<TestUser> => {
    const doc = await harness.payload.create({
      collection: 'users',
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
      } as never,
      overrideAccess: true,
    })

    return {
      collection: 'users',
      email: doc.email as string,
      id: doc.id as number,
      role: 'user',
      tenants,
    }
  }

  beforeEach(async () => {
    harness = await bootTestPayload({
      collections: [alertSubscriptionCollection(), ...taxonomies()],
    })

    employerA = await makeUser('employer', [{ role: 'employer', tenant: harness.tenantA.id }])
    editorA = await makeUser('editor', [{ role: 'editor', tenant: harness.tenantA.id }])
    seekerA = await makeUser('seeker', [{ role: 'seeker', tenant: harness.tenantA.id }])
  })

  afterEach(async () => {
    if (harness) await harness.destroy()
  })

  const subscribe = (
    tenant: number,
    data: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ) =>
    harness.payload.create({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      data: {
        email: `seeker-${Math.random().toString(36).slice(2, 8)}@example.invalid`,
        tenant,
        ...data,
      } as never,
      overrideAccess: true,
      ...options,
    })

  it('mints tokens, stores the address lowercase and starts unconfirmed', async () => {
    const doc = (await subscribe(harness.tenantA.id, {
      email: '  Seeker@Example.INVALID ',
      keywords: '  nurse   pacific ',
    })) as Record<string, unknown>

    expect(doc).toMatchObject({
      confirmed: false,
      email: 'seeker@example.invalid',
      keywords: 'nurse pacific',
    })
    expect(doc.confirmToken).toMatch(ALERT_TOKEN_PATTERN)
    expect(doc.manageToken).toMatch(ALERT_TOKEN_PATTERN)
    expect(doc.confirmToken).not.toBe(doc.manageToken)
  })

  it('keeps an imported token and confirmation, so the importer can bring subscribers over', async () => {
    const token = generateAlertToken()
    const doc = await subscribe(harness.tenantA.id, {
      confirmed: true,
      confirmToken: token,
      legacyId: 4242,
      manageToken: generateAlertToken(),
    })

    expect(doc).toMatchObject({ confirmed: true, confirmToken: token, legacyId: 4242 })
  })

  it('rejects a second subscription for the same address in the same tenant', async () => {
    await subscribe(harness.tenantA.id, { email: 'seeker@example.invalid' })

    const error = await subscribe(harness.tenantA.id, { email: 'SEEKER@example.invalid' }).catch(
      (thrown: unknown) => thrown,
    )

    expect(fieldMessages(error)).toBe(
      'seeker@example.invalid is already subscribed on this site',
    )
  })

  it('allows the same address on two tenants', async () => {
    await subscribe(harness.tenantA.id, { email: 'seeker@example.invalid' })

    await expect(
      subscribe(harness.tenantB.id, { email: 'seeker@example.invalid' }),
    ).resolves.toMatchObject({ email: 'seeker@example.invalid' })
  })

  it('rejects a subscription with no tenant', async () => {
    const error = await harness.payload
      .create({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        data: { email: 'nowhere@example.invalid' } as never,
        overrideAccess: true,
      })
      .catch((thrown: unknown) => thrown)

    expect(fieldMessages(error)).toBe('An alert subscription must belong to a tenant')
  })

  it('rejects filters that belong to another tenant', async () => {
    const foreignLocation = await harness.payload.create({
      collection: 'locations',
      data: {
        kind: 'town',
        name: 'Port Vila',
        slug: 'port-vila',
        tenant: harness.tenantB.id,
      } as never,
      overrideAccess: true,
    })

    const foreignError = await subscribe(harness.tenantA.id, {
      locations: [foreignLocation.id],
    }).catch((thrown: unknown) => thrown)

    expect(fieldMessages(foreignError)).toBe(
      'Pick only filters from this subscription’s tenant',
    )

    const ownLocation = await harness.payload.create({
      collection: 'locations',
      data: {
        kind: 'town',
        name: 'Luganville',
        slug: 'luganville',
        tenant: harness.tenantA.id,
      } as never,
      overrideAccess: true,
    })

    const ownTenant = (await subscribe(harness.tenantA.id, {
      locations: [ownLocation.id],
    })) as { locations?: (number | { id: number | string })[] }

    expect(ownTenant.locations?.map((location) => String(relationshipID(location)))).toEqual([
      String(ownLocation.id),
    ])
  })

  it('lets a tenant admin read their tenant and nobody else’s subscribers', async () => {
    const own = await subscribe(harness.tenantA.id)
    await subscribe(harness.tenantB.id)

    const asAdmin = await harness.payload.find({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      user: harness.tenantAdminA as never,
    })
    expect(asAdmin.docs.map((doc) => String(doc.id))).toEqual([String(own.id)])

    for (const user of [editorA, employerA, seekerA]) {
      await expect(
        harness.payload.find({ collection: ALERT_SUBSCRIPTIONS_SLUG, user: user as never }),
      ).rejects.toThrow()
    }
  })

  it('lets a super admin read every tenant but not see the tokens', async () => {
    const a = await subscribe(harness.tenantA.id)
    const b = await subscribe(harness.tenantB.id)

    const { docs } = await harness.payload.find({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      user: harness.superAdmin as never,
    })

    expect(new Set(docs.map((doc) => String(doc.id)))).toEqual(
      new Set([String(a.id), String(b.id)]),
    )
    for (const doc of docs) {
      expect(doc).not.toHaveProperty('confirmToken')
      expect(doc).not.toHaveProperty('manageToken')
    }

    // The token endpoints look a subscription up with overrideAccess, where the token is there.
    const readBack = await harness.payload.findByID({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      id: a.id,
      overrideAccess: true,
    })
    expect(readBack.confirmToken).toMatch(ALERT_TOKEN_PATTERN)
  })

  it('rejects API writes, even for a tenant admin or super admin', async () => {
    for (const user of [harness.tenantAdminA, harness.superAdmin]) {
      await expect(
        harness.payload.create({
          collection: ALERT_SUBSCRIPTIONS_SLUG,
          data: { email: 'write@example.invalid', tenant: harness.tenantA.id } as never,
          user: user as never,
        }),
      ).rejects.toThrow()
    }
  })

  it('cancels every subscription when its tenant is deleted', async () => {
    const doomed = await harness.payload.create({
      collection: 'tenants',
      data: { name: 'Doomed', slug: 'doomed' } as never,
      overrideAccess: true,
    })

    await subscribe(Number(doomed.id), { email: 'doomed@example.invalid' })

    await harness.payload.delete({
      collection: 'tenants',
      id: doomed.id,
      user: harness.superAdmin as never,
    })

    const { totalDocs } = await harness.payload.count({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      overrideAccess: true,
      where: { tenant: { equals: doomed.id } },
    })

    expect(totalDocs).toBe(0)
  })
})
