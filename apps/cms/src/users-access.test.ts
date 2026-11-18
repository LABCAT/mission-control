import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { Tags } from './collections/Tags'
import { Tenants } from './collections/Tenants'
import { Users } from './collections/Users'
import { multiTenantOptions } from './tenancy'

type GlobalRole = 'super-admin' | 'user'
type TenantRole = 'editor' | 'employer' | 'tenant-admin'

type TestTenant = { id: number }
/** The caller identity the local API accepts, mirroring what a JWT puts on `req.user`. */
type Caller = {
  collection: 'users'
  id: number
  role: GlobalRole
  tenants: { role: TenantRole; tenant: number }[]
}

const buildTestConfig = async () => {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL

  if (!testDatabaseUrl) {
    throw new Error(
      'Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests',
    )
  }

  return buildConfig({
    admin: { user: 'users' },
    auth: { passwordHashIterations: 100000 },
    collections: [Users, Media, Folders, Tags, Tenants],
    db: postgresAdapter({
      pool: { connectionString: testDatabaseUrl, max: 10 },
      // CI gets a fresh Postgres; push the schema for this test run instead of migrations.
      push: true,
      // Its own schema, so this config's tables never collide with the other test config's.
      schemaName: 'users_access',
    }),
    plugins: [multiTenantPlugin(multiTenantOptions)],
    secret: 'test-secret',
  })
}

describe('users access', () => {
  let payload: Payload
  let tenantA: TestTenant
  let tenantB: TestTenant
  let superAdmin: Caller
  let tenantAdminA: Caller
  let memberA: Caller
  let otherMemberA: Caller
  let memberB: Caller
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const createdTenantIDs: number[] = []
  const createdUserIDs: number[] = []

  const createTenant = async (name: string, slug: string): Promise<TestTenant> => {
    const tenant = (await payload.create({
      collection: 'tenants',
      data: { name, slug: `${slug}-${runId}` },
      overrideAccess: true,
    })) as TestTenant
    createdTenantIDs.push(tenant.id)

    return tenant
  }

  const createUser = async ({
    email,
    role,
    tenants,
  }: {
    email: string
    role: GlobalRole
    tenants: { role: TenantRole; tenant: number }[]
  }): Promise<Caller> => {
    const user = (await payload.create({
      collection: 'users',
      data: {
        email: `${email}-${runId}@example.invalid`,
        password: 'test-password',
        role,
        tenants,
      },
      overrideAccess: true,
    })) as { id: number }
    createdUserIDs.push(user.id)

    return { collection: 'users', id: user.id, role, tenants }
  }

  beforeAll(async () => {
    payload = await getPayload({
      config: await buildTestConfig(),
      key: `users-access-${runId}`,
    })

    tenantA = await createTenant('Tenant A', 'users-access-a')
    tenantB = await createTenant('Tenant B', 'users-access-b')

    // Created first: `ensureFirstUserIsSuperAdmin` promotes the first user of an empty database.
    superAdmin = await createUser({ email: 'super-admin', role: 'super-admin', tenants: [] })
    tenantAdminA = await createUser({
      email: 'tenant-admin-a',
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: tenantA.id }],
    })
    memberA = await createUser({
      email: 'member-a',
      role: 'user',
      tenants: [{ role: 'employer', tenant: tenantA.id }],
    })
    otherMemberA = await createUser({
      email: 'other-member-a',
      role: 'user',
      tenants: [{ role: 'editor', tenant: tenantA.id }],
    })
    memberB = await createUser({
      email: 'member-b',
      role: 'user',
      tenants: [{ role: 'employer', tenant: tenantB.id }],
    })

    // A super-admin who is also a member of tenant A, so the tenant admin would otherwise reach them.
    await payload.update({
      collection: 'users',
      data: { tenants: [{ role: 'employer', tenant: tenantA.id }] },
      id: superAdmin.id,
      overrideAccess: true,
    })
  })

  afterAll(async () => {
    if (!payload) return

    await payload.delete({
      collection: 'users',
      overrideAccess: true,
      where: { id: { in: createdUserIDs } },
    })
    await payload.delete({
      collection: 'tenants',
      overrideAccess: true,
      where: { id: { in: createdTenantIDs } },
    })

    await payload.destroy()
  })

  it('rejects a tenant-admin update of a super-admin in their tenant', async () => {
    await expect(
      payload.update({
        collection: 'users',
        data: { firstName: 'Hijacked' },
        id: superAdmin.id,
        user: tenantAdminA as never,
      }),
    ).rejects.toThrow()

    const stored = (await payload.findByID({
      collection: 'users',
      id: superAdmin.id,
      overrideAccess: true,
    })) as { firstName?: string }
    expect(stored.firstName).not.toBe('Hijacked')
  })

  it('rejects a tenant-admin delete of a super-admin in their tenant', async () => {
    await expect(
      payload.delete({ collection: 'users', id: superAdmin.id, user: tenantAdminA as never }),
    ).rejects.toThrow()

    const stored = await payload.findByID({
      collection: 'users',
      id: superAdmin.id,
      overrideAccess: true,
    })
    expect(stored.id).toBe(superAdmin.id)
  })

  it('still lets a tenant-admin update a normal member of their tenant', async () => {
    const updated = (await payload.update({
      collection: 'users',
      data: { firstName: 'Updated by tenant admin' },
      id: memberA.id,
      user: tenantAdminA as never,
    })) as { firstName?: string }

    expect(updated.firstName).toBe('Updated by tenant admin')
  })

  it('rejects a tenant-admin update of a member of another tenant', async () => {
    await expect(
      payload.update({
        collection: 'users',
        data: { firstName: 'Wrong tenant' },
        id: memberB.id,
        user: tenantAdminA as never,
      }),
    ).rejects.toThrow()
  })

  it('lets a super-admin update anyone', async () => {
    const updated = (await payload.update({
      collection: 'users',
      data: { firstName: 'Updated by super admin' },
      id: tenantAdminA.id,
      user: superAdmin as never,
    })) as { firstName?: string }

    expect(updated.firstName).toBe('Updated by super admin')
  })

  it('lets a user update themself', async () => {
    const updated = (await payload.update({
      collection: 'users',
      data: { firstName: 'My own name' },
      id: otherMemberA.id,
      user: otherMemberA as never,
    })) as { firstName?: string }

    expect(updated.firstName).toBe('My own name')
  })

  it('rejects a plain member updating another user', async () => {
    await expect(
      payload.update({
        collection: 'users',
        data: { firstName: 'Someone else' },
        id: memberA.id,
        user: otherMemberA as never,
      }),
    ).rejects.toThrow()
  })
})
