import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import {
  buildConfig,
  getPayload,
  type CollectionConfig,
  type Payload,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  authenticatedAccess,
  globalRoleOptions,
  isSuperAdmin,
  superAdminAccess,
  tenantRoleOptions,
} from '../access'

export type TestTenant = { id: number; name: string; slug: string }

export type TestUser = {
  collection: string
  email: string
  id: number
  role: 'super-admin' | 'user'
  tenants: { role: string; tenant: number }[]
}

export type TestHarness = {
  destroy: () => Promise<void>
  payload: Payload
  superAdmin: TestUser
  tenantA: TestTenant
  tenantAdminA: TestUser
  tenantAdminB: TestUser
  tenantB: TestTenant
}

const Tenants: CollectionConfig = {
  slug: 'tenants',
  admin: { useAsTitle: 'name' },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: superAdminAccess,
  },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true, index: true },
  ],
  versions: false,
}

const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email' },
  auth: true,
  access: {
    create: () => true,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: () => true,
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
  ],
  versions: false,
}

type BootTestPayloadArgs = {
  /** Tenant-scoped collections under test, scoped by the multi-tenant plugin. */
  collections: CollectionConfig[]
  /** Explicit disposable Postgres database; schema push must not target the CMS database. */
  databaseUrl?: string
}

let bootCount = 0

/**
 * Boot a Payload instance against Postgres (schema pushed for the test run) and seed
 * two tenants, A and B, plus a super-admin and one tenant-admin per tenant.
 *
 * The users are real auth documents: Payload's authorship tracking (`createdBy` /
 * `updatedBy`) foreign-keys every document a user creates back to the users collection.
 */
export const bootTestPayload = async ({
  collections,
  databaseUrl,
}: BootTestPayloadArgs): Promise<TestHarness> => {
  const testDatabaseUrl = databaseUrl ?? process.env.TEST_DATABASE_URL

  if (!testDatabaseUrl) {
    throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests')
  }

  const config = await buildConfig({
    admin: { user: 'users' },
    auth: { passwordHashIterations: 100000 },
    secret: 'test-secret',
    collections: [Users, Tenants, ...collections],
    db: postgresAdapter({
      pool: {
        connectionString: testDatabaseUrl,
        max: 10,
      },
      // CI gets a fresh Postgres; push the schema for this test run instead of migrations.
      push: true,
    }),
    plugins: [
      multiTenantPlugin({
        collections: Object.fromEntries(collections.map((collection) => [collection.slug, {}])),
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
  })

  // A unique key so concurrent tests never reuse a cached Payload instance.
  const payload = await getPayload({ config, key: `payload-jobs-test-${++bootCount}` })

  // Unique slugs and emails per boot so the suite is re-runnable against the same
  // database without a destructive wipe or clashing with earlier runs.
  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

  const createdA = (await payload.create({
    collection: 'tenants',
    data: { name: 'Tenant A', slug: `tenant-a-${runId}` },
    overrideAccess: true,
  })) as TestTenant
  const createdB = (await payload.create({
    collection: 'tenants',
    data: { name: 'Tenant B', slug: `tenant-b-${runId}` },
    overrideAccess: true,
  })) as TestTenant

  const tenantA = { id: createdA.id, name: createdA.name, slug: createdA.slug }
  const tenantB = { id: createdB.id, name: createdB.name, slug: createdB.slug }

  // Real users, because Payload's authorship tracking (createdBy / updatedBy) has a
  // foreign key to the auth collection on every document a user creates.
  const createUser = async (
    email: string,
    role: TestUser['role'],
    tenants: TestUser['tenants'],
  ): Promise<TestUser> => {
    const doc = (await payload.create({
      collection: 'users',
      data: { email, password: 'test-password', role, tenants },
      overrideAccess: true,
    })) as { email: string; id: number }

    return { collection: 'users', email: doc.email, id: doc.id, role, tenants }
  }

  const superAdmin = await createUser(`super-admin-${runId}@example.invalid`, 'super-admin', [])
  const tenantAdminA = await createUser(`tenant-admin-a-${runId}@example.invalid`, 'user', [
    { role: 'tenant-admin', tenant: tenantA.id },
  ])
  const tenantAdminB = await createUser(`tenant-admin-b-${runId}@example.invalid`, 'user', [
    { role: 'tenant-admin', tenant: tenantB.id },
  ])

  const destroy = async (): Promise<void> => {
    try {
      await Promise.all(
        collections.map(({ slug }) =>
          payload.delete({
            collection: slug,
            overrideAccess: true,
            where: { tenant: { in: [tenantA.id, tenantB.id] } },
          }),
        ),
      )
      await payload.delete({
        collection: 'users',
        overrideAccess: true,
        where: { id: { in: [superAdmin.id, tenantAdminA.id, tenantAdminB.id] } },
      })
      await payload.delete({
        collection: 'tenants',
        overrideAccess: true,
        where: { id: { in: [tenantA.id, tenantB.id] } },
      })
    } finally {
      await payload.destroy()
    }
  }

  return {
    destroy,
    payload,
    superAdmin,
    tenantA,
    tenantAdminA,
    tenantAdminB,
    tenantB,
  }
}

type TenantIsolationArgs = {
  /** The collection to exercise; it must be tenant-scoped by the multi-tenant plugin. */
  collection: CollectionConfig
  /** Returns the non-tenant fields for a new document; the harness adds `tenant`. */
  createData: (tenant: TestTenant) => Record<string, unknown>
}

/**
 * Shared tenant-isolation test suite for the `payload-jobs` collections. Boots a fresh
 * Payload against Postgres, seeds tenants A and B, then asserts a tenant-admin of A can
 * neither read, write nor delete tenant B's documents (and vice versa), while a
 * super-admin can see everything. Later tasks call this once per collection.
 */
export const tenantIsolation = ({ collection, createData }: TenantIsolationArgs): void => {
  const slug = collection.slug

  describe(`tenant isolation: ${slug}`, () => {
    let harness: TestHarness
    let docA: { id: number | string }
    let docB: { id: number | string }

    beforeAll(async () => {
      harness = await bootTestPayload({ collections: [collection] })

      docA = (await harness.payload.create({
        collection: slug,
        data: { ...createData(harness.tenantA), tenant: harness.tenantA.id },
        user: harness.tenantAdminA as never,
      })) as { id: number | string }
      docB = (await harness.payload.create({
        collection: slug,
        data: { ...createData(harness.tenantB), tenant: harness.tenantB.id },
        user: harness.tenantAdminB as never,
      })) as { id: number | string }
    })

    afterAll(async () => {
      if (harness) await harness.destroy()
    })

    it('scopes reads to the user’s own tenant', async () => {
      const { docs } = await harness.payload.find({
        collection: slug,
        user: harness.tenantAdminA as never,
      })

      expect(docs.map((doc) => String(doc.id))).toEqual([String(docA.id)])
    })

    it('rejects a create that targets another tenant', async () => {
      await expect(
        harness.payload.create({
          collection: slug,
          data: { ...createData(harness.tenantB), tenant: harness.tenantB.id },
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('rejects an update of another tenant’s document', async () => {
      await expect(
        harness.payload.update({
          collection: slug,
          data: createData(harness.tenantB),
          id: docB.id,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('rejects a delete of another tenant’s document', async () => {
      await expect(
        harness.payload.delete({
          collection: slug,
          id: docB.id,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('lets a super-admin read every tenant’s documents', async () => {
      const { docs } = await harness.payload.find({
        collection: slug,
        user: harness.superAdmin as never,
        where: { tenant: { in: [harness.tenantA.id, harness.tenantB.id] } },
      })

      const ids = docs.map((doc) => String(doc.id))
      expect(ids).toEqual(expect.arrayContaining([String(docA.id), String(docB.id)]))
      expect(ids).toHaveLength(2)
    })
  })
}
