import type { AccessArgs, CollectionConfig, Config, Field } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ALERT_READER_ROLES,
  ALERT_SUBSCRIPTIONS_SLUG,
  alertSubscriptionCollection,
  normalizeAlertEmail,
  normalizeAlertKeywords,
  removeTenantAlertSubscriptions,
  uniqueAlertPerSearch,
} from './subscriptions'
import { alertsTenantCollections, payloadJobsAlerts } from './index'
import {
  locationsCollection,
  payloadJobs,
  taxonomyCollections,
  type MissionControlUser,
  type TenantCleanupHook,
} from '@mission-control/payload-jobs'
import { bootTestPayload, type TestHarness, type TestUser } from '@mission-control/payload-jobs/test'

/** The host's own tenant hook, to prove the plugin appends rather than replaces. */
const hostHook = () => undefined

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

  it('is registered by the add-on plugin and can be switched off', async () => {
    const baseConfig = {
      collections: [{ slug: 'users', fields: [] }],
      secret: 'test',
    } as never

    const core = await payloadJobs()(baseConfig)
    const on = await payloadJobsAlerts()(core)
    expect(on.collections?.map((candidate) => candidate.slug)).toContain(ALERT_SUBSCRIPTIONS_SLUG)
    // Core no longer adds it by itself.
    expect(core.collections?.map((candidate) => candidate.slug)).not.toContain(
      ALERT_SUBSCRIPTIONS_SLUG,
    )

    const off = await payloadJobsAlerts({ enabled: false })(core)
    expect(off.collections?.map((candidate) => candidate.slug)).not.toContain(
      ALERT_SUBSCRIPTIONS_SLUG,
    )
  })

  it('honours a slug override and gates its access and writes by add-on', async () => {
    const core = await payloadJobs()({ collections: [{ slug: 'users', fields: [] }], secret: 'test' } as never)
    const config = payloadJobsAlerts({ slug: 'subscribers' })(core) as Config
    const added = config.collections?.find((candidate) => candidate.slug === 'subscribers')

    expect(added?.hooks?.beforeValidate).toHaveLength(4)
    expect(
      added?.fields.find((field) => 'name' in field && field.name === 'categories'),
    ).toMatchObject({ relationTo: 'job-categories' })
    // Single-tenant read: super admin reads, unless the settings switch alerts off.
    const read = added?.access?.read as (args: unknown) => Promise<unknown>
    const reqFor = (addOns: unknown) => ({
      payload: { findGlobal: async () => ({ addOns }) },
      user: { id: 1, role: 'super-admin', tenants: [] },
    })
    expect(await read({ req: reqFor(['alerts']) })).toBe(true)
    expect(await read({ req: reqFor(['reports']) })).toBe(false)
    expect(alertsTenantCollections({ slug: 'subscribers' })).toEqual(['subscribers'])
    expect(alertsTenantCollections()).toEqual([ALERT_SUBSCRIPTIONS_SLUG])
  })

  it('needs payloadJobs() before it, and refuses a clashing slug', async () => {
    const bare = { collections: [], secret: 'test' } as never
    expect(() => payloadJobsAlerts()(bare)).toThrow(/no registry/)

    const core = await payloadJobs()(bare)
    expect(() => payloadJobsAlerts({ slug: 'jobs' })(core)).toThrow(/already exists/)
  })

  it('has the fields the task asks for, plus legacyId for the importer', () => {
    expect(collection.fields.map((field) => ('name' in field ? field.name : field.type))).toEqual([
      'email',
      'frequency',
      'active',
      'filterKey',
      'confirmed',
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

  it('stores no token: the links are signed, so nothing secret sits in a row', () => {
    for (const name of ['confirmToken', 'manageToken']) {
      expect(collection.fields.some((field) => 'name' in field && field.name === name)).toBe(false)
    }

    expect(fieldNamed(collection, 'frequency')).toMatchObject({ defaultValue: 'daily', type: 'select' })
    expect(fieldNamed(collection, 'active')).toMatchObject({ defaultValue: true, type: 'checkbox' })
    // One alert per address and search; a different search is a second alert.
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'email', 'filterKey'], unique: true }])
  })

  it('is unique per search, address and tenant (per address and search when unscoped)', () => {
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'email', 'filterKey'], unique: true }])
    // An address can hold several alerts, so the address alone is not unique any more.
    expect(fieldNamed(collection, 'email')).toMatchObject({ index: true })
    expect(fieldNamed(collection, 'email')).not.toMatchObject({ unique: true })

    const single = alertSubscriptionCollection({ tenantScoped: false })
    expect(single.indexes).toEqual([{ fields: ['email', 'filterKey'], unique: true }])
  })

  it('skips versions so Payload does not create _v tables', () => {
    expect(collection.versions).toBe(false)
  })

  it('removes a tenant’s subscriptions when the tenant is deleted', async () => {
    const baseConfig = {
      collections: [
        { slug: 'users', fields: [], auth: { verify: true } },
        { slug: 'tenants', fields: [], hooks: { beforeDelete: [hostHook] } },
      ],
      secret: 'test',
    } as never

    const tenantsOf = async (withAlerts: boolean) => {
      const core = await payloadJobs({ tenancy: 'multi' })(baseConfig)
      const config = withAlerts ? await payloadJobsAlerts()(core) : core
      return config.collections?.find((candidate) => candidate.slug === 'tenants')
    }

    const withAlerts = await tenantsOf(true)
    const hooks = withAlerts?.hooks?.beforeDelete ?? []
    const cleanup = hooks.find((hook) =>
      (hook as Partial<TenantCleanupHook>).tenantCleanupCollections?.includes(ALERT_SUBSCRIPTIONS_SLUG),
    ) as TenantCleanupHook | undefined
    // Marked as a tenant cleanup, so the tenant data guard (PJ-93) knows these rows never
    // outlive the tenant and never block its deletion.
    expect(cleanup?.tenantCleanupCollections).toEqual([ALERT_SUBSCRIPTIONS_SLUG])
    // The host's own hook keeps running: the plugin appends, it does not replace.
    expect(hooks[0]).toBe(hostHook)

    const withoutAlerts = await tenantsOf(false)
    const hooksWithoutAlerts = withoutAlerts?.hooks?.beforeDelete ?? []
    expect(hooksWithoutAlerts.some((hook) => (hook as Partial<TenantCleanupHook>).tenantCleanupCollections !== undefined && (hook as TenantCleanupHook).tenantCleanupCollections.includes(ALERT_SUBSCRIPTIONS_SLUG))).toBe(false)
    expect(hooksWithoutAlerts).toContain(hostHook)
    // Pages, menus and orders keep their own cleanup; the only difference is the subscription hook.
    expect(hooks.length).toBe(hooksWithoutAlerts.length + 1)
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

describe('unique search per address and tenant hook', () => {
  const hook = uniqueAlertPerSearch(true)

  it('looks the address up lowercased inside the tenant', async () => {
    const { find, req } = requestWith([])

    await expect(
      hook({
        data: { email: ' Seeker@Example.invalid ', filterKey: 'q=nurse|c=|t=|l=', tenant: 10 },
        req,
      } as never),
    ).resolves.toMatchObject({ tenant: 10 })

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        overrideAccess: true,
        where: {
          and: [
            { email: { equals: 'seeker@example.invalid' } },
            { filterKey: { equals: 'q=nurse|c=|t=|l=' } },
            { tenant: { equals: 10 } },
          ],
        },
      }),
    )
  })

  it('rejects an address already subscribed in the same tenant', async () => {
    const { req } = requestWith([{ id: 7 }])

    const error = await hook({
      data: { email: 'seeker@example.invalid', filterKey: '', tenant: 10 },
      req,
    } as never).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      data: {
        errors: [
          { message: 'seeker@example.invalid already has this alert', path: 'email' },
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

    await uniqueAlertPerSearch(false)({
      data: { email: 'seeker@example.invalid', filterKey: '' },
      req,
    } as never)

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          and: [{ email: { equals: 'seeker@example.invalid' } }, { filterKey: { equals: '' } }],
        },
      }),
    )
  })
})

const taxonomies = (): CollectionConfig[] => [
  ...taxonomyCollections({ tenantScoped: true }),
  locationsCollection({ requireTenant: true }),
]

describe('alert subscriptions integration @S-084', () => {
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
      // The plugin adds this to the host's tenants collection; the harness boots without it.
      tenantHooks: { beforeDelete: [removeTenantAlertSubscriptions] },
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

  it('stores the address lowercase, starts unconfirmed, daily and active', async () => {
    const doc = (await subscribe(harness.tenantA.id, {
      email: '  Seeker@Example.INVALID ',
      keywords: '  nurse   pacific ',
    })) as Record<string, unknown>

    expect(doc).toMatchObject({
      active: true,
      confirmed: false,
      email: 'seeker@example.invalid',
      filterKey: 'q=nurse pacific|c=|t=|l=',
      frequency: 'daily',
      keywords: 'nurse pacific',
    })
  })

  it('keeps an imported confirmation, so the importer can bring subscribers over', async () => {
    const doc = await subscribe(harness.tenantA.id, { confirmed: true, legacyId: 4242 })

    expect(doc).toMatchObject({ confirmed: true, legacyId: 4242 })
  })

  it('rejects the same search twice for one address in one tenant @S-085', async () => {
    await subscribe(harness.tenantA.id, { email: 'seeker@example.invalid', keywords: 'Nurse' })

    const error = await subscribe(harness.tenantA.id, {
      email: 'SEEKER@example.invalid',
      keywords: ' nurse ',
    }).catch((thrown: unknown) => thrown)

    expect(fieldMessages(error)).toBe('seeker@example.invalid already has this alert')
  })

  it('allows several alerts for one address when their searches differ @S-086', async () => {
    await subscribe(harness.tenantA.id, { email: 'seeker@example.invalid', keywords: 'nurse' })
    await subscribe(harness.tenantA.id, { email: 'seeker@example.invalid', keywords: 'driver' })
    await expect(
      subscribe(harness.tenantA.id, { email: 'seeker@example.invalid', frequency: 'weekly' }),
    ).resolves.toMatchObject({ filterKey: '', frequency: 'weekly' })

    const { totalDocs } = await harness.payload.count({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      overrideAccess: true,
      where: { email: { equals: 'seeker@example.invalid' } },
    })
    expect(totalDocs).toBe(3)
  })

  it('still rejects the same search twice when the writes race', async () => {
    const results = await Promise.allSettled([
      subscribe(harness.tenantA.id, { email: 'race@example.invalid', keywords: 'cook' }),
      subscribe(harness.tenantA.id, { email: 'race@example.invalid', keywords: 'cook' }),
    ])

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
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

  it('lets a super admin read every tenant', async () => {
    const a = await subscribe(harness.tenantA.id)
    const b = await subscribe(harness.tenantB.id)

    const { docs } = await harness.payload.find({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      user: harness.superAdmin as never,
    })

    expect(new Set(docs.map((doc) => String(doc.id)))).toEqual(
      new Set([String(a.id), String(b.id)]),
    )
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

    const subscription = await subscribe(Number(doomed.id), { email: 'doomed@example.invalid' })

    await harness.payload.delete({
      collection: 'tenants',
      id: doomed.id,
      user: harness.superAdmin as never,
    })

    // The row itself must be gone, not detached: `tenant_id` is nullable, so reading it back
    // by id is what separates a cascade from an ON DELETE SET NULL that orphans the address
    // and its tokens.
    const readBack = await harness.payload
      .findByID({
        collection: ALERT_SUBSCRIPTIONS_SLUG,
        id: subscription.id,
        overrideAccess: true,
      })
      .catch(() => null)

    expect(readBack).toBeNull()

    const { totalDocs } = await harness.payload.count({
      collection: ALERT_SUBSCRIPTIONS_SLUG,
      overrideAccess: true,
      where: { tenant: { equals: doomed.id } },
    })

    expect(totalDocs).toBe(0)
  })
})
