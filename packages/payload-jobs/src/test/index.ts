import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
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

/**
 * A minimal stand-in for orbit's `media` collection, so SEO and hero uploads resolve. Tests that
 * do not pass it are booted without it; Payload rejects an upload field pointing at a missing
 * collection, so pass `media: true` whenever the collection under test has upload fields.
 */
const Media: CollectionConfig = {
  slug: 'media',
  fields: [{ name: 'alt', type: 'text' }],
  upload: true,
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
  /** Collections registered with the plugin's `isGlobal` option (one document per tenant). */
  globalCollections?: string[]
  /** Add the stub `media` collection, required by upload fields. */
  media?: boolean
}

let bootCount = 0

/**
 * Boot a Payload instance against Postgres (schema pushed for the test run) and seed
 * two tenants, A and B, plus a super-admin and one tenant-admin per tenant.
 *
 * The users are real auth documents: Payload's authorship tracking (`createdBy` /
 * `updatedBy`) foreign-keys every document a user creates back to the users collection.
 *
 * Rich text needs an editor, so a lexical editor is installed config-wide; that is what the
 * real CMS does too.
 *
 * Each boot pushes into its own Postgres schema. Vitest runs test files in parallel and each
 * file boots a different set of collections; sharing one schema would make drizzle-kit ask
 * "create or rename this table?" and hang. The schema is dropped on `destroy()`.
 */
export const bootTestPayload = async ({
  collections,
  databaseUrl,
  globalCollections = [],
  media = false,
}: BootTestPayloadArgs): Promise<TestHarness> => {
  const testDatabaseUrl = databaseUrl ?? process.env.TEST_DATABASE_URL

  if (!testDatabaseUrl) {
    throw new Error('Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests')
  }

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const schemaName = `payload_jobs_test_${runId}`

  const isGlobal = new Set(globalCollections)
  const pluginCollections = Object.fromEntries(
    collections.map((collection) => [
      collection.slug,
      isGlobal.has(collection.slug) ? { isGlobal: true } : {},
    ]),
  )

  const config = await buildConfig({
    admin: { user: 'users' },
    auth: { passwordHashIterations: 100000 },
    editor: lexicalEditor(),
    secret: 'test-secret',
    collections: [Users, Tenants, ...(media ? [Media] : []), ...collections],
    db: postgresAdapter({
      pool: {
        connectionString: testDatabaseUrl,
        max: 10,
      },
      // CI gets a fresh Postgres; push the schema for this test run instead of migrations.
      push: true,
      schemaName,
    }),
    plugins: [
      multiTenantPlugin({
        collections: pluginCollections,
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

  const tenantIds: number[] = []
  const userIds: number[] = []
  const destroy = async (): Promise<void> => {
    const cleanupErrors: unknown[] = []

    for (const { slug } of collections) {
      if (tenantIds.length === 0) break

      try {
        await payload.delete({
          collection: slug,
          overrideAccess: true,
          where: { tenant: { in: tenantIds } },
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    if (userIds.length > 0) {
      try {
        await payload.delete({
          collection: 'users',
          overrideAccess: true,
          where: { id: { in: userIds } },
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    if (tenantIds.length > 0) {
      try {
        await payload.delete({
          collection: 'tenants',
          overrideAccess: true,
          where: { id: { in: tenantIds } },
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    const pool = payload.db.pool as { query: (sql: string) => Promise<unknown> }
    try {
      // Drop this boot's schema so repeated local runs never accumulate tables.
      await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
    } catch (error) {
      cleanupErrors.push(error)
    }

    try {
      await payload.destroy()
    } catch (error) {
      cleanupErrors.push(error)
    }

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'Failed to clean up the Payload test harness')
    }
  }

  try {
    const createdA = (await payload.create({
      collection: 'tenants',
      data: { name: 'Tenant A', slug: `tenant-a-${runId}` },
      overrideAccess: true,
    })) as TestTenant
    tenantIds.push(createdA.id)

    const createdB = (await payload.create({
      collection: 'tenants',
      data: { name: 'Tenant B', slug: `tenant-b-${runId}` },
      overrideAccess: true,
    })) as TestTenant
    tenantIds.push(createdB.id)

    const tenantA = { id: createdA.id, name: createdA.name, slug: createdA.slug }
    const tenantB = { id: createdB.id, name: createdB.name, slug: createdB.slug }

    // Real users, because authorship tracking has a foreign key to the auth collection.
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
      userIds.push(doc.id)

      return { collection: 'users', email: doc.email, id: doc.id, role, tenants }
    }

    const superAdmin = await createUser(`super-admin-${runId}@example.invalid`, 'super-admin', [])
    const tenantAdminA = await createUser(`tenant-admin-a-${runId}@example.invalid`, 'user', [
      { role: 'tenant-admin', tenant: tenantA.id },
    ])
    const tenantAdminB = await createUser(`tenant-admin-b-${runId}@example.invalid`, 'user', [
      { role: 'tenant-admin', tenant: tenantB.id },
    ])

    return {
      destroy,
      payload,
      superAdmin,
      tenantA,
      tenantAdminA,
      tenantAdminB,
      tenantB,
    }
  } catch (error) {
    try {
      await destroy()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Test harness setup and cleanup both failed', {
        cause: cleanupError,
      })
    }

    throw error
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
