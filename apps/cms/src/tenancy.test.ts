import type { Config } from 'payload'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { describe, expect, it } from 'vitest'

import type { MissionControlUser } from '@mission-control/payload-jobs'

import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { Tags } from './collections/Tags'
import { Tenants } from './collections/Tenants'
import { ensureFirstUserIsSuperAdmin, Users } from './collections/Users'
import { multiTenantOptions } from './tenancy'

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

const buildConfig = async (): Promise<Config> =>
  (await multiTenantPlugin(multiTenantOptions)({
    admin: { user: 'users' },
    collections: [Users, Media, Folders, Tags, Tenants],
  } as Config)) as Config

const requestFor = (user: MissionControlUser | null) => ({
  payload: {},
  payloadAPI: 'REST',
  t: (key: string) => key,
  user,
})

const baseAccess = async (
  config: Config,
  operation: 'delete' | 'read' | 'update',
  slug: string,
  user: MissionControlUser | null,
) => {
  const access = config.baseAccess?.collections?.[operation] as
    | ((args: unknown) => Promise<unknown>)
    | undefined

  if (!access) throw new Error(`Missing base access for ${operation}`)

  return access({ req: requestFor(user), slug })
}

const beforeValidateFor = (config: Config, slug: string) => {
  const collection = config.collections?.find((candidate) => candidate.slug === slug)
  const hook = collection?.hooks?.beforeValidate?.[0]

  if (!hook) throw new Error(`Missing beforeValidate hook for ${slug}`)

  return hook as (args: unknown) => unknown
}

const runHook = (hook: (args: unknown) => unknown, args: unknown) =>
  Promise.resolve().then(() => hook(args))

describe('tenant isolation', () => {
  it.each(['folders', 'media', 'tags'])(
    'scopes %s reads, updates and deletes to the tenant on the user',
    async (slug) => {
      const config = await buildConfig()

      const read = (await baseAccess(config, 'read', slug, tenantAdminA)) as {
        tenant: { in: number[] }
      }
      const update = (await baseAccess(config, 'update', slug, tenantAdminA)) as {
        tenant: { in: number[] }
      }
      const remove = (await baseAccess(config, 'delete', slug, tenantAdminA)) as {
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

  it.each(['folders', 'media', 'tags'])(
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

    expect(await baseAccess(config, 'read', 'media', superAdmin)).toBe(true)
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

    expect(await baseAccess(config, 'read', 'media', noTenants)).toBe(false)
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
})
