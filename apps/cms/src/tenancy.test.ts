import type { CollectionBeforeChangeHook, Config } from 'payload'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_SIGNUP_CONTEXT,
  hashSiteKey,
  PAYLOAD_JOBS_TENANT_COLLECTIONS,
  payloadJobs,
  resolvePayloadJobsSlugs,
  type MissionControlUser,
} from '@mission-control/payload-jobs'
import { payloadJobsAlerts, removeTenantAlertSubscriptions } from '@mission-control/payload-jobs-alerts'
import { payloadJobsXero } from '@mission-control/payload-jobs-xero'

import { Documents } from './collections/Documents'
import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { Tags } from './collections/Tags'
import { removeTenantMemberships, removeTenantSiteKeys, Tenants } from './collections/Tenants'
import {
  ensureFirstUserIsSuperAdmin,
  preventTenantAdminCredentialChanges,
  Users,
  usersReadAccess,
  usersUpdateAccess,
} from './collections/Users'
import { siteKeyAllowedCollections } from './site-keys'
import { multiTenantOptions, multiTenantOptionsFor } from './tenancy'

type TestUser = MissionControlUser & { collection: 'users' }

const tenantA = { id: 1, name: 'Tenant A' }
const tenantB = { id: 2, name: 'Tenant B' }

const tenantAdminA: TestUser = {
  id: 10,
  collection: 'users',
  role: 'user',
  tenants: [{ role: 'tenant-admin', tenant: tenantA }],
}

const tenantAdminB: TestUser = {
  id: 20,
  collection: 'users',
  role: 'user',
  tenants: [{ role: 'tenant-admin', tenant: tenantB }],
}

const superAdmin: TestUser = {
  id: 99,
  collection: 'users',
  role: 'super-admin',
  tenants: [],
}

const buildConfig = async (): Promise<Config> => {
  const base = await payloadJobs({ tenancy: 'multi' })({
    admin: { user: 'users' },
    collections: [Users, Media, Folders, Tags, Tenants, Documents],
  } as Config)
  // mission-control: the alerts add-on is its own plugin since PJ-115.
  const withAlerts = await payloadJobsAlerts()(base)
  // mission-control: the Xero add-on (PJ-57).
  const withJobs = await payloadJobsXero()(withAlerts)

  return (await multiTenantPlugin(multiTenantOptions)(withJobs)) as Config
}

const requestFor = (user: MissionControlUser | null) => ({
  // The add-on gate asks which tenants have the add-on on; every tenant here does.
  payload: { find: async () => ({ docs: [{ id: tenantA.id }] }) },
  payloadAPI: 'REST',
  t: (key: string) => key,
  user,
})

const baseAccess = async (
  config: Config,
  operation: 'create' | 'delete' | 'read' | 'update',
  slug: string,
  user: MissionControlUser | null,
) => {
  const access = config.baseAccess?.collections?.[operation] as
    | ((args: unknown) => Promise<unknown>)
    | undefined

  if (!access) throw new Error(`Missing base access for ${operation}`)

  return access({ req: requestFor(user), slug })
}

/**
 * Collections with a site-key `accessResultOverride` get their combined access on the
 * collection itself, not on `config.baseAccess`.
 */
const collectionAccess = async (
  config: Config,
  operation: 'create' | 'delete' | 'read' | 'update',
  slug: string,
  user: MissionControlUser | null,
) => {
  const access = config.collections?.find((candidate) => candidate.slug === slug)?.access?.[
    operation
  ] as ((args: unknown) => Promise<unknown>) | undefined

  if (!access) throw new Error(`Missing collection access for ${slug}.${operation}`)

  return access({ req: requestFor(user), slug })
}

const beforeValidateFor = (config: Config, slug: string) => {
  const collection = config.collections?.find((candidate) => candidate.slug === slug)
  const hook = collection?.hooks?.beforeValidate?.[0]

  if (!hook) throw new Error(`Missing beforeValidate hook for ${slug}`)

  return hook as (args: unknown) => unknown
}

/**
 * An anonymous request like a public site sends: a keyed `x-site-key` header and a payload
 * whose `find` resolves that digest to a site key document, unless `known` is false.
 */
const siteKeyRequest = async ({
  drafts = false,
  isAggregate = false,
  key,
  known = true,
  tenant,
}: {
  drafts?: boolean
  isAggregate?: boolean
  key: string
  known?: boolean
  tenant: number
}) => ({
  context: {},
  headers: new Headers({ 'x-site-key': key }),
  payload: {
    collections: { media: { config: { versions: { drafts } } } },
    find: async (args: { where?: { keyHash?: { equals?: string } } }) => ({
      docs:
        known && args.where?.keyHash?.equals === (await hashSiteKey(key))
          ? [{ id: 1, tenant: { id: tenant, isAggregate } }]
          : [],
    }),
  },
  payloadAPI: 'REST',
  t: (path: string) => path,
  user: null,
})

const collectionAccessWithReq = async (
  config: Config,
  operation: 'create' | 'read',
  slug: string,
  req: unknown,
) => {
  const access = config.collections?.find((candidate) => candidate.slug === slug)?.access?.[
    operation
  ] as ((args: unknown) => Promise<unknown>) | undefined

  if (!access) throw new Error(`Missing collection access for ${slug}.${operation}`)

  return access({ req, slug })
}

const runHook = (hook: (args: unknown) => unknown, args: unknown) =>
  Promise.resolve().then(() => hook(args))

const runBeforeChange = (hook: CollectionBeforeChangeHook, args: Record<string, unknown>) =>
  Promise.resolve().then(() => hook(args as never))

describe('tenant isolation', () => {
  it.each(['folders', 'locations', 'media', 'tags'])(
    'scopes %s reads, updates and deletes to the tenant on the user',
    async (slug) => {
      const config = await buildConfig()

      const read = (await collectionAccess(config, 'read', slug, tenantAdminA)) as {
        tenant: { in: number[] }
      }
      const update = (await collectionAccess(config, 'update', slug, tenantAdminA)) as {
        tenant: { in: number[] }
      }
      const remove = (await collectionAccess(config, 'delete', slug, tenantAdminA)) as {
        tenant: { in: number[] }
      }

      expect(read).toEqual({ tenant: { in: [tenantA.id] } })
      expect(update).toEqual({ tenant: { in: [tenantA.id] } })
      expect(remove).toEqual({ tenant: { in: [tenantA.id] } })

      expect(read.tenant.in).not.toContain(tenantB.id)
      expect(update.tenant.in).not.toContain(tenantB.id)
      expect(remove.tenant.in).not.toContain(tenantB.id)
    },
  )

  it.each(['folders', 'locations', 'media', 'tags'])(
    'rejects a %s create for another tenant in beforeValidate',
    async (slug) => {
      const config = await buildConfig()
      const beforeValidate = beforeValidateFor(config, slug)

      await expect(
        runHook(beforeValidate, {
          data: { tenant: tenantB.id },
          req: requestFor(tenantAdminA),
        }),
      ).rejects.toThrow()

      await expect(
        runHook(beforeValidate, {
          data: { tenant: tenantA.id },
          req: requestFor(tenantAdminA),
        }),
      ).resolves.toEqual({ tenant: tenantA.id })
    },
  )

  it('lets tenant B’s admin write tenant B, but not tenant A', async () => {
    const config = await buildConfig()
    const beforeValidate = beforeValidateFor(config, 'media')

    await expect(
      runHook(beforeValidate, {
        data: { tenant: tenantA.id },
        req: requestFor(tenantAdminB),
      }),
    ).rejects.toThrow()
    await expect(
      runHook(beforeValidate, {
        data: { tenant: tenantB.id },
        req: requestFor(tenantAdminB),
      }),
    ).resolves.toEqual({ tenant: tenantB.id })
  })

  it('lets a super-admin read and assign every tenant', async () => {
    const config = await buildConfig()
    const beforeValidate = beforeValidateFor(config, 'media')

    expect(await collectionAccess(config, 'read', 'media', superAdmin)).toBe(true)
    await expect(
      runHook(beforeValidate, {
        data: { tenant: tenantB.id },
        req: requestFor(superAdmin),
      }),
    ).resolves.toEqual({ tenant: tenantB.id })
  })

  it('denies a user with no tenant memberships', async () => {
    const config = await buildConfig()
    const noTenants: TestUser = { id: 30, collection: 'users', role: 'user', tenants: [] }

    expect(await collectionAccess(config, 'read', 'media', noTenants)).toBe(false)
  })

  it('scopes user reads to the tenant plus the user themselves', async () => {
    const config = await buildConfig()
    const read = (await baseAccess(config, 'read', 'users', tenantAdminA)) as {
      or: [{ id: { equals: number } }, { 'tenants.tenant': { in: number[] } }]
    }

    expect(read).toEqual({
      or: [{ id: { equals: tenantAdminA.id } }, { 'tenants.tenant': { in: [tenantA.id] } }],
    })
  })

  it('scopes tenant reads to the tenants on the user', async () => {
    const config = await buildConfig()
    const read = (await baseAccess(config, 'read', 'tenants', tenantAdminA)) as {
      id: { in: number[] }
    }

    expect(read).toEqual({ id: { in: [tenantA.id] } })
  })

  it('only lets users update themselves unless they are tenant-admins', async () => {
    const editorA: TestUser = {
      id: 11,
      collection: 'users',
      role: 'user',
      tenants: [{ role: 'editor', tenant: tenantA }],
    }
    const argsFor = (user: MissionControlUser | null) =>
      ({ req: { user } }) as unknown as Parameters<typeof usersUpdateAccess>[0]

    expect(await usersUpdateAccess(argsFor(tenantAdminA))).toEqual({
      and: [
        { 'tenants.tenant': { in: [tenantA.id] } },
        { role: { not_equals: 'super-admin' } },
      ],
    })
    expect(await usersUpdateAccess(argsFor(editorA))).toEqual({
      id: { equals: editorA.id },
    })
    expect(await usersUpdateAccess(argsFor(superAdmin))).toBe(true)
    expect(await usersUpdateAccess(argsFor(null))).toBe(false)
  })
})

describe('seekers (site accounts)', () => {
  const seeker: TestUser = {
    id: 30,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'seeker', tenant: tenantA }],
  }
  const argsFor = (user: MissionControlUser | null) =>
    ({ req: { user } }) as unknown as Parameters<typeof usersReadAccess>[0]

  it('lets a seeker read only their own user, and everyone else keep the tenant-scoped read', async () => {
    expect(await usersReadAccess(argsFor(seeker))).toEqual({ id: { equals: seeker.id } })
    expect(await usersReadAccess(argsFor(tenantAdminA))).toBe(true)
    expect(await usersReadAccess(argsFor(superAdmin))).toBe(true)
    expect(await usersReadAccess(argsFor(null))).toBe(false)
  })

  it('keeps seekers out of the admin panel', async () => {
    const admin = Users.access?.admin as (args: unknown) => boolean

    expect(admin({ req: { user: seeker } })).toBe(false)
    expect(admin({ req: { user: tenantAdminA } })).toBe(true)
  })

  it('denies a seeker the tenant content their membership would otherwise open', async () => {
    const config = await buildConfig()

    for (const slug of ['media', 'folders', 'tags', 'documents']) {
      for (const operation of ['read', 'update', 'delete'] as const) {
        expect(await collectionAccess(config, operation, slug, seeker), `${slug}.${operation}`).toBe(
          false,
        )
      }

      // A tenant-admin of the same tenant is unaffected.
      expect(await collectionAccess(config, 'read', slug, tenantAdminA)).not.toBe(false)
    }
  })

  it('verifies email on site sign-ups', () => {
    expect(Users.auth).toMatchObject({ verify: true })
  })
})

describe('site key reads', () => {
  it('lets a tenant key read its own tenant only', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'media', req)).toEqual({
      tenant: { equals: tenantA.id },
    })
  })

  it('lets an aggregate key read every tenant without the plugin re-adding a filter', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ isAggregate: true, key: 'sk_hub', tenant: 1 })

    expect(await collectionAccessWithReq(config, 'read', 'media', req)).toBe(true)
  })

  it('scopes an aggregate key to published docs when the collection has drafts', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({
      drafts: true,
      isAggregate: true,
      key: 'sk_hub',
      tenant: 1,
    })

    expect(await collectionAccessWithReq(config, 'read', 'media', req)).toEqual({
      _status: { equals: 'published' },
    })
  })

  it('hides drafts from a tenant key when the collection has drafts', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ drafts: true, key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'media', req)).toEqual({
      and: [{ tenant: { equals: tenantA.id } }, { _status: { equals: 'published' } }],
    })
  })

  it('rejects an aggregate key write', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ isAggregate: true, key: 'sk_hub', tenant: 1 })

    expect(await collectionAccessWithReq(config, 'create', 'media', req)).toBe(false)
  })

  it('rejects an unknown key', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_unknown', known: false, tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'media', req)).toBe(false)
  })

  it('exposes the public location tree to a site key, scoped to its tenant', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'locations', req)).toEqual({
      tenant: { equals: tenantA.id },
    })
  })

  it('still scopes a collection whose own read access denies anonymous requests', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'tags', req)).toEqual({
      tenant: { equals: tenantA.id },
    })
  })
})

describe('job-board taxonomies', () => {
  const taxonomySlugs = ['job-categories', 'job-types', 'salary-bands']

  it.each(taxonomySlugs)('registers %s and scopes its reads to the user’s tenants', async (slug) => {
    const config = await buildConfig()

    expect(config.collections?.some((collection) => collection.slug === slug)).toBe(true)
    expect(await collectionAccess(config, 'read', slug, tenantAdminA)).toEqual({
      tenant: { in: [tenantA.id] },
    })
  })

  it.each(taxonomySlugs)('lets a site key read %s for one tenant only', async (slug) => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', slug, req)).toEqual({
      tenant: { equals: tenantA.id },
    })
  })

  it('lets a tenant-admin create a taxonomy but not an employer', async () => {
    const config = await buildConfig()
    const employer: TestUser = {
      id: 12,
      collection: 'users',
      role: 'user',
      tenants: [{ role: 'employer', tenant: tenantA }],
    }

    expect(await collectionAccess(config, 'create', 'salary-bands', tenantAdminA)).toBeTruthy()
    expect(await collectionAccess(config, 'create', 'salary-bands', employer)).toBe(false)
  })
})

describe('plans (PJ-21)', () => {
  const employerA: TestUser = {
    id: 30,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'employer', tenant: tenantA }],
  }
  const seekerA: TestUser = {
    id: 31,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'seeker', tenant: tenantA }],
  }
  const active = { status: { equals: 'active' } }

  it('registers every tenant-scoped job-board collection with the multi-tenant plugin', () => {
    for (const slug of PAYLOAD_JOBS_TENANT_COLLECTIONS) {
      expect(Object.keys(multiTenantOptions.collections)).toContain(slug)
    }
  })

  it('registers the plans collection with its tenant field', async () => {
    const config = await buildConfig()
    const plans = config.collections?.find((collection) => collection.slug === 'plans')

    expect(plans?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
  })

  it('shows staff every plan in their tenant and employers only active ones', async () => {
    const config = await buildConfig()

    expect(await collectionAccess(config, 'read', 'plans', tenantAdminA)).toEqual({
      and: [{ tenant: { in: [tenantA.id] } }, { tenant: { in: [tenantA.id] } }],
    })
    expect(await collectionAccess(config, 'read', 'plans', employerA)).toEqual({
      and: [
        { and: [{ tenant: { in: [tenantA.id] } }, active] },
        { tenant: { in: [tenantA.id] } },
      ],
    })
    expect(await collectionAccess(config, 'read', 'plans', seekerA)).toBe(false)
    expect(await collectionAccess(config, 'read', 'plans', null)).toBe(false)
  })

  it('lets a site key read only its tenant’s active plans', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })
    ;(req.payload.collections as Record<string, unknown>)['site-keys'] = {}

    expect(await collectionAccessWithReq(config, 'read', 'plans', req)).toEqual({
      and: [{ tenant: { equals: tenantA.id } }, active],
    })
  })

  it('does not let employers or site keys write plans', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccess(config, 'update', 'plans', employerA)).toBe(false)
    expect(await collectionAccess(config, 'delete', 'plans', tenantAdminA)).toBe(false)
    expect(await collectionAccessWithReq(config, 'create', 'plans', req)).toBe(false)
  })
})

describe('alert subscriptions (PJ-26)', () => {
  const seekerA: TestUser = {
    id: 31,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'seeker', tenant: tenantA }],
  }

  it('registers the collection and scopes reads to the tenant admin', async () => {
    const config = await buildConfig()
    const alerts = config.collections?.find(
      (collection) => collection.slug === 'alert-subscriptions',
    )

    expect(alerts?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
    // The add-on gate narrows the read to tenants that have alerts switched on.
    expect(await collectionAccess(config, 'read', 'alert-subscriptions', tenantAdminA)).toEqual({
      and: [{ tenant: { in: [tenantA.id] } }, { tenant: { in: [tenantA.id] } }],
    })
    // The plugin's own tenant constraint sits in front of the collection's read access.
    expect(await baseAccess(config, 'read', 'alert-subscriptions', tenantAdminA)).toEqual({
      tenant: { in: [tenantA.id] },
    })
    // Editors and seekers never see the subscriber list.
    const editorA: TestUser = {
      id: 32,
      collection: 'users',
      role: 'user',
      tenants: [{ role: 'editor', tenant: tenantA }],
    }
    expect(await collectionAccess(config, 'read', 'alert-subscriptions', editorA)).toBe(false)
    expect(await collectionAccess(config, 'read', 'alert-subscriptions', seekerA)).toBe(false)
  })

  it('rejects anonymous and site-key writes, so subscribers use their token links', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccess(config, 'create', 'alert-subscriptions', tenantAdminA)).toBe(
      false,
    )
    expect(await collectionAccessWithReq(config, 'read', 'alert-subscriptions', req)).toBe(false)
    expect(await collectionAccessWithReq(config, 'create', 'alert-subscriptions', req)).toBe(false)
  })
})

describe('organisations (PJ-18)', () => {
  const employerA: TestUser = {
    id: 40,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'employer', tenant: tenantA }],
    organisation: 5,
  }
  const seekerA: TestUser = {
    id: 41,
    collection: 'users',
    role: 'user',
    tenants: [{ role: 'seeker', tenant: tenantA }],
    organisation: 5,
  }

  it('registers organisations with the multi-tenant plugin and a tenant field', async () => {
    const config = await buildConfig()
    const organisations = config.collections?.find((collection) => collection.slug === 'organisations')

    expect(organisations?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(
      true,
    )
    expect(PAYLOAD_JOBS_TENANT_COLLECTIONS).toContain('organisations')
  })

  it('adds the organisation relation to users', async () => {
    const config = await buildConfig()
    const users = config.collections?.find((collection) => collection.slug === 'users')

    expect(users?.fields.some((field) => 'name' in field && field.name === 'organisation')).toBe(true)
  })

  it('scopes staff reads to their tenant and an employer to their own organisation', async () => {
    const config = await buildConfig()

    expect(await collectionAccess(config, 'read', 'organisations', tenantAdminA)).toEqual({
      and: [{ tenant: { in: [tenantA.id] } }, { tenant: { in: [tenantA.id] } }],
    })
    // The employer clause carries its own tenant check: the plugin's filter includes every
    // membership, seeker included, so the link alone must not open a profile.
    expect(await collectionAccess(config, 'read', 'organisations', employerA)).toEqual({
      and: [
        { and: [{ id: { equals: 5 } }, { tenant: { in: [tenantA.id] } }] },
        { tenant: { in: [tenantA.id] } },
      ],
    })
    expect(await collectionAccess(config, 'read', 'organisations', seekerA)).toBe(false)
    expect(await collectionAccess(config, 'read', 'organisations', null)).toBe(false)
  })

  it('lets a site key read only approved, page-enabled organisations of its tenant', async () => {
    const config = await buildConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })
    ;(req.payload.collections as Record<string, unknown>)['site-keys'] = {}

    // An anonymous request carries no tenant scope, so the plugin leaves the collection's own
    // filter alone; the filter already pins the site key's tenant and the published state.
    expect(await collectionAccessWithReq(config, 'read', 'organisations', req)).toEqual({
      and: [
        { tenant: { equals: tenantA.id } },
        { and: [{ approved: { equals: true } }, { pageEnabled: { equals: true } }] },
      ],
    })
  })

  it('lets an employer update only their own organisation and never delete one', async () => {
    const config = await buildConfig()

    expect(await collectionAccess(config, 'update', 'organisations', employerA)).toEqual({
      and: [
        { and: [{ id: { equals: 5 } }, { tenant: { in: [tenantA.id] } }] },
        { tenant: { in: [tenantA.id] } },
      ],
    })
    expect(await collectionAccess(config, 'delete', 'organisations', employerA)).toBe(false)
    expect(await collectionAccess(config, 'delete', 'organisations', tenantAdminA)).toEqual({
      and: [{ tenant: { in: [tenantA.id] } }, { tenant: { in: [tenantA.id] } }],
    })
  })
})

describe('coupons', () => {
  it('registers the coupons collection with its tenant field', async () => {
    const config = await buildConfig()
    const coupons = config.collections?.find((collection) => collection.slug === 'coupons')

    expect(coupons).toBeDefined()
    expect(coupons?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
  })

  it('scopes coupon reads to the tenants on the user', async () => {
    const config = await buildConfig()

    expect(await collectionAccess(config, 'read', 'coupons', tenantAdminA)).toEqual({
      tenant: { in: [tenantA.id] },
    })
    expect(await collectionAccess(config, 'read', 'coupons', tenantAdminB)).toEqual({
      tenant: { in: [tenantB.id] },
    })
    // Super admins are not constrained to a tenant.
    expect(await collectionAccess(config, 'read', 'coupons', superAdmin)).toBe(true)
  })

  it('keeps coupons out of reach for anonymous requests and site keys', async () => {
    const config = await buildConfig()
    const coupons = config.collections?.find((candidate) => candidate.slug === 'coupons')
    const read = coupons?.access?.read as (args: unknown) => Promise<unknown>

    expect(await read({ req: requestFor(null), slug: 'coupons' })).toBe(false)

    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await read({ req, slug: 'coupons' })).toBe(false)
  })
})

describe('orders', () => {
  it('registers the orders collection with its tenant field @S-146', async () => {
    const config = await buildConfig()
    const orders = config.collections?.find((collection) => collection.slug === 'orders')

    expect(orders).toBeDefined()
    expect(orders?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
  })

  it('keeps orders out of reach for anonymous requests and site keys @S-146', async () => {
    const config = await buildConfig()
    const orders = config.collections?.find((candidate) => candidate.slug === 'orders')
    const read = orders?.access?.read as (args: unknown) => Promise<unknown>

    expect(await read({ req: requestFor(null), slug: 'orders' })).toBe(false)

    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await read({ req, slug: 'orders' })).toBe(false)
  })

  it('refuses to delete a tenant that has orders before the plugin removes anything @S-146', async () => {
    const config = await buildConfig()
    const tenants = config.collections?.find((collection) => collection.slug === 'tenants')
    // The app's own two hooks run first (the delete's transaction rolls them back); the order
    // guard comes next, before the plugin's clean-ups.
    const guard = tenants?.hooks?.beforeDelete?.[2]
    const count = async () => ({ totalDocs: 2 })
    const req = { payload: { collections: { orders: {} }, count } }

    await expect(
      (guard as (args: unknown) => Promise<void>)({ collection: { slug: 'tenants' }, id: 1, req }),
    ).rejects.toMatchObject({ data: { errors: [expect.objectContaining({ message: expect.stringMatching(/kept for accounting/) })] } })
  })
})

describe('credit ledger', () => {
  it('registers the credit ledger with its tenant field @S-149', async () => {
    const config = await buildConfig()
    const ledger = config.collections?.find((collection) => collection.slug === 'credit-ledger')

    expect(ledger).toBeDefined()
    expect(ledger?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
  })

  it('keeps the credit ledger out of reach for anonymous requests and site keys @S-149', async () => {
    const config = await buildConfig()
    const ledger = config.collections?.find((candidate) => candidate.slug === 'credit-ledger')
    const read = ledger?.access?.read as (args: unknown) => Promise<unknown>

    expect(await read({ req: requestFor(null), slug: 'credit-ledger' })).toBe(false)

    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await read({ req, slug: 'credit-ledger' })).toBe(false)
  })

  it('refuses to delete a tenant that has credit movements @S-149', async () => {
    const config = await buildConfig()
    const tenants = config.collections?.find((collection) => collection.slug === 'tenants')
    const guard = tenants?.hooks?.beforeDelete?.[3]
    const count = async () => ({ totalDocs: 1 })
    const req = { context: {}, payload: { collections: { 'credit-ledger': {} }, count } }

    await expect(
      (guard as (args: unknown) => Promise<void>)({ collection: { slug: 'tenants' }, id: 1, req }),
    ).rejects.toMatchObject({ data: { errors: [expect.objectContaining({ message: expect.stringMatching(/credit movement/) })] } })
  })
})

describe('Xero add-on', () => {
  const employerA: TestUser = { id: 30, collection: 'users', role: 'user', tenants: [{ role: 'employer', tenant: tenantA }] }

  it.each(['xero-settings', 'xero-invoices'])('registers %s with its tenant field @S-102', async (slug) => {
    const config = await buildConfig()
    const collection = config.collections?.find((candidate) => candidate.slug === slug)

    expect(collection?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
  })

  it.each(['xero-settings', 'xero-invoices'])(
    'keeps %s from anonymous requests, site keys and employers, and narrows site managers to their tenant @S-102',
    async (slug) => {
      const config = await buildConfig()
      const collection = config.collections?.find((candidate) => candidate.slug === slug)
      const read = collection?.access?.read as (args: unknown) => Promise<unknown>

      expect(await read({ req: requestFor(null), slug })).toBe(false)
      expect(await read({ req: await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id }), slug })).toBe(false)
      expect(await read({ req: requestFor(employerA), slug })).toBe(false)
      expect(await read({ req: requestFor(tenantAdminA), slug })).toEqual({ tenant: { in: [tenantA.id] } })
    },
  )

  it('lets no one write invoice records through the API @S-151', async () => {
    const config = await buildConfig()
    const invoices = config.collections?.find((candidate) => candidate.slug === 'xero-invoices')

    for (const operation of ['create', 'update', 'delete'] as const) {
      const access = invoices?.access?.[operation] as (args: unknown) => Promise<unknown>
      expect(await access({ req: requestFor(superAdmin) })).toBe(false)
    }
  })
})

describe('credential updates', () => {
  const target = { id: 20, email: 'b@example.com' }

  it('rejects email and password changes for another user', async () => {
    await expect(
      runBeforeChange(preventTenantAdminCredentialChanges, {
        data: { email: 'c@example.com' },
        operation: 'update',
        originalDoc: target,
        req: requestFor(tenantAdminA),
      }),
    ).rejects.toThrow()

    await expect(
      runBeforeChange(preventTenantAdminCredentialChanges, {
        data: { password: 'new-password' },
        operation: 'update',
        originalDoc: target,
        req: requestFor(tenantAdminA),
      }),
    ).rejects.toThrow()
  })

  it('allows profile edits, self edits and super-admin edits', async () => {
    await expect(
      runBeforeChange(preventTenantAdminCredentialChanges, {
        data: { firstName: 'B' },
        operation: 'update',
        originalDoc: target,
        req: requestFor(tenantAdminA),
      }),
    ).resolves.toEqual({ firstName: 'B' })

    await expect(
      runBeforeChange(preventTenantAdminCredentialChanges, {
        data: { email: 'new@example.com' },
        operation: 'update',
        originalDoc: { id: tenantAdminA.id, email: 'a@example.com' },
        req: requestFor(tenantAdminA),
      }),
    ).resolves.toEqual({ email: 'new@example.com' })

    await expect(
      runBeforeChange(preventTenantAdminCredentialChanges, {
        data: { email: 'new@example.com', password: 'new-password' },
        operation: 'update',
        originalDoc: target,
        req: requestFor(superAdmin),
      }),
    ).resolves.toEqual({ email: 'new@example.com', password: 'new-password' })
  })
})

describe('renamed collection slugs (PJ-80)', () => {
  const collections = {
    jobCategories: { slug: 'categories' },
    menus: { slug: 'nav-menus' },
    pages: { slug: 'content-pages' },
  }
  const slugs = resolvePayloadJobsSlugs(collections)

  const buildRenamedConfig = async (): Promise<Config> => {
    const withJobs = await payloadJobs({ collections, tenancy: 'multi' })({
      admin: { user: 'users' },
      collections: [Users, Media, Folders, Tags, Tenants, Documents],
    } as Config)

    return (await multiTenantPlugin(multiTenantOptionsFor(slugs))(withJobs)) as Config
  }

  it('registers the multi-tenant overrides under the renamed slugs, not the defaults', async () => {
    const config = await buildRenamedConfig()

    expect(config.collections?.some((collection) => collection.slug === 'content-pages')).toBe(
      true,
    )
    expect(
      await collectionAccess(config, 'read', 'content-pages', tenantAdminA),
    ).toEqual({ tenant: { in: [tenantA.id] } })
    expect(multiTenantOptionsFor(slugs).collections).not.toHaveProperty('pages')
    expect(multiTenantOptionsFor(slugs).collections).not.toHaveProperty('menus')
  })

  it('lets a site key read a renamed page and menu collection, and refuses the old names', async () => {
    const config = await buildRenamedConfig()
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: tenantA.id })

    expect(await collectionAccessWithReq(config, 'read', 'content-pages', req)).toEqual({
      tenant: { equals: tenantA.id },
    })
    expect(await collectionAccessWithReq(config, 'read', 'nav-menus', req)).toEqual({
      tenant: { equals: tenantA.id },
    })
    expect(
      siteKeyAllowedCollections(slugs),
    ).toEqual(expect.arrayContaining(['content-pages', 'nav-menus', 'categories']))
    expect(siteKeyAllowedCollections(slugs)).not.toContain('pages')
  })

  it('scopes and seeds a renamed pages collection', async () => {
    const config = await buildRenamedConfig()
    const pages = config.collections?.find((collection) => collection.slug === 'content-pages')
    const tenant = config.collections?.find((collection) => collection.slug === 'tenants')
    const afterChange = tenant?.hooks?.afterChange?.[0]

    expect(pages?.fields.some((field) => 'name' in field && field.name === 'tenant')).toBe(true)
    expect(afterChange).toBeDefined()

    const created: { collection: string }[] = []
    await runHook(afterChange as (args: unknown) => unknown, {
      doc: { id: 7, slug: 'new-site' },
      operation: 'create',
      req: {
        payload: {
          create: async (args: { collection: string }) => {
            created.push(args)
            return { id: created.length }
          },
          find: async () => ({ docs: [] }),
        },
      },
    })

    expect(created.map((args) => args.collection)).toEqual([
      'content-pages',
      'content-pages',
      'content-pages',
      'content-pages',
    ])
  })
})

describe('tenant deletion', () => {
  it('removes the tenant from user memberships before deleting it', async () => {
    const findCalls: unknown[] = []
    const updates: unknown[] = []
    const users = [
      {
        id: 10,
        tenants: [
          { role: 'tenant-admin', tenant: 1 },
          { role: 'editor', tenant: 2 },
        ],
      },
      { id: 20, tenants: [{ role: 'tenant-admin', tenant: 2 }] },
    ]
    const req = {
      payload: {
        find: async (args: unknown) => {
          findCalls.push(args)
          const tenantIDs = (
            args as { where?: { 'tenants.tenant'?: { in?: number[] } } }
          ).where?.['tenants.tenant']?.in

          return {
            docs: users.filter((user) =>
              user.tenants.some((membership) => tenantIDs?.includes(membership.tenant as number)),
            ),
          }
        },
        update: async (args: unknown) => {
          updates.push(args)
          return {}
        },
      },
    }

    await removeTenantMemberships({ id: 1, req } as never)

    expect(findCalls[0]).toEqual(
      expect.objectContaining({
        collection: 'users',
        pagination: false,
        where: { 'tenants.tenant': { in: [1] } },
      }),
    )
    expect(findCalls[0]).not.toHaveProperty('limit')
    expect(updates).toEqual([
      expect.objectContaining({
        id: 10,
        data: { tenants: [{ role: 'editor', tenant: 2 }] },
      }),
    ])
  })

  it('deletes the tenant’s alert subscriptions before the tenant itself', async () => {
    const config = await buildConfig()
    const tenants = config.collections?.find((collection) => collection.slug === 'tenants')

    // The app's own hooks still run first; the plugin appends the subscription cleanup, so a
    // subscriber's address and tokens cannot outlive the tenant as an orphaned row.
    expect(tenants?.hooks?.beforeDelete?.slice(0, 2)).toEqual([
      removeTenantMemberships,
      removeTenantSiteKeys,
    ])
    expect(tenants?.hooks?.beforeDelete).toContain(removeTenantAlertSubscriptions)
  })
})

describe('first user bootstrap', () => {
  const requestWithCount = (totalDocs: number) =>
    ({
      payload: {
        count: async () => ({ totalDocs }),
      },
    }) as never

  it('promotes the first user and leaves later users unchanged', async () => {
    await expect(
      ensureFirstUserIsSuperAdmin({
        data: { role: 'user' },
        operation: 'create',
        req: requestWithCount(0),
      } as never),
    ).resolves.toEqual({ role: 'super-admin' })

    await expect(
      ensureFirstUserIsSuperAdmin({
        data: { role: 'user' },
        operation: 'create',
        req: requestWithCount(1),
      } as never),
    ).resolves.toEqual({ role: 'user' })

    await expect(
      ensureFirstUserIsSuperAdmin({
        data: { role: 'user' },
        operation: 'update',
        req: requestWithCount(0),
      } as never),
    ).resolves.toEqual({ role: 'user' })
  })

  it('never promotes a site sign-up, even on an empty database', async () => {
    const req = {
      context: { [ACCOUNT_SIGNUP_CONTEXT]: true },
      payload: { count: async () => ({ totalDocs: 0 }) },
    } as never

    await expect(
      ensureFirstUserIsSuperAdmin({ data: { role: 'user' }, operation: 'create', req } as never),
    ).resolves.toEqual({ role: 'user' })
  })
})
