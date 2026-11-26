import { anonymiseUser, payloadJobs } from '@mission-control/payload-jobs'
import { MysqlReader, runImport, usersImporters } from '@mission-control/payload-wp-import'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The fixture connection is test support of the import package, not part of its public API.
import {
  createFixtureConnection,
  userTables,
} from '../../../packages/payload-wp-import/src/test/fixtures'
import { Documents } from './collections/Documents'
import { Folders } from './collections/Folders'
import { Media } from './collections/Media'
import { SiteKeys } from './collections/SiteKeys'
import { Tags } from './collections/Tags'
import { Tenants } from './collections/Tenants'
import { Users } from './collections/Users'
import { multiTenantOptions } from './tenancy'

// Real Payload on Postgres: the PJ-62 import writes users through the database adapter and the
// WordPress password then signs them in. Runs in its own schema on the disposable test database.
const databaseUrl = process.env.TEST_DATABASE_URL
const NOW = new Date('2026-11-20T00:00:00Z')
const PHPASS = '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0'
const PASSWORD = 'test12345'

describe.skipIf(!databaseUrl)('legacy users import (PJ-62) @S-130', () => {
  let payload: Payload
  let tenant: { id: number }
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

  const importUsers = (dryRun: boolean, refreshCredentials = false) => {
    const connection = createFixtureConnection(userTables)
    return runImport({
      dryRun,
      importers: Object.values(usersImporters({ now: () => NOW })),
      payload: payload as never,
      reader: new MysqlReader({ connect: async () => connection }),
      refreshCredentials,
      tenant: tenant.id,
    })
  }

  const userByLegacyId = async (legacyId: number) =>
    (
      await payload.find({
        collection: 'users',
        depth: 0,
        limit: 1,
        overrideAccess: true,
        showHiddenFields: true,
        where: { and: [{ legacyId: { equals: legacyId } }, { 'tenants.tenant': { equals: tenant.id } }] },
      })
    ).docs[0] as unknown as Record<string, any>

  beforeAll(async () => {
    const config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Media, Folders, Tags, Tenants, SiteKeys, Documents],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl, max: 10 },
        push: true,
        schemaName: 'wp_import_users_test',
      }),
      plugins: [payloadJobs({ tenancy: 'multi' }), multiTenantPlugin(multiTenantOptions)],
      secret: 'test-secret',
    })
    payload = await getPayload({ config, key: 'wp-import-users-test' })
    await removeFixtureUsers() // a failed earlier run may have left the fixture emails behind

    tenant = (await payload.create({
      collection: 'tenants',
      data: {
        adminEmail: 'admin@import.example.invalid',
        currency: 'VUV',
        currencyMinorUnits: 0,
        defaultLocale: 'en',
        emailFromAddress: 'noreply@import.example.invalid',
        emailFromName: 'import',
        locales: [{ locale: 'en' }],
        name: 'import',
        slug: `import-${run}`,
        taxLabel: 'VAT',
        timezone: 'Pacific/Efate',
      } as never,
      overrideAccess: true,
    })) as { id: number }
  })

  const removeFixtureUsers = () =>
    payload.delete({
      collection: 'users',
      // mission-control: the plugin refuses a real user delete (PJ-89); teardown bypasses it.
      context: { payloadJobsPurge: true },
      overrideAccess: true,
      where: { or: [{ email: { like: '@example.com' } }, { email: { like: '@removed.invalid' } }] },
    })

  afterAll(async () => {
    await removeFixtureUsers()
    await payload?.destroy()
  })

  it('imports owners, members, seekers and managers with their organisations', async () => {
    const summary = await importUsers(false)

    expect(summary.errors).toEqual([])
    expect(summary.importers.organisations).toMatchObject({ created: 4, failed: 0 })
    expect(summary.importers.users).toMatchObject({ created: 8, failed: 0 })

    const owner = await userByLegacyId(2)
    const member = await userByLegacyId(3)
    expect(owner).toMatchObject({ email: 'pat@example.com', organisationRole: 'owner', role: 'user' })
    expect(owner.tenants).toMatchObject([{ role: 'employer' }])
    expect(owner.organisation).toBe(member.organisation)
    expect(member.organisationRole).toBe('member')
    expect((await userByLegacyId(5)).tenants).toMatchObject([{ role: 'seeker' }])
    expect((await userByLegacyId(1)).tenants).toMatchObject([{ role: 'tenant-admin' }])

    const org = (await payload.findByID({
      collection: 'organisations' as never,
      depth: 0,
      id: owner.organisation,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>
    expect(org).toMatchObject({
      billingEmail: 'billing@example.com',
      canPayByInvoice: true,
      legacyId: 2,
      name: 'Example Resort Ltd',
      pageEnabled: true,
      type: 'business',
      xeroContactCode: 'XC-100',
    })
  })

  it('stores the WordPress hash, never a password, and the user signs in with the old password', async () => {
    const user = await userByLegacyId(2)
    expect(user.legacyPasswordHash).toMatch(/^\$P\$/)
    expect(user.hash).toBeFalsy()

    // A wrong password is refused and leaves the hash alone, as PJ-34 specifies.
    await expect(
      payload.login({ collection: 'users', data: { email: 'pat@example.com', password: 'wrong' } }),
    ).rejects.toThrow()
    expect((await userByLegacyId(2)).legacyPasswordHash).toBe(user.legacyPasswordHash)

    // The fixture hashes are made up; swap in a real phpass hash of PASSWORD to see the sign-in.
    await payload.db.updateOne({
      collection: 'users',
      data: { legacyPasswordHash: PHPASS },
      where: { id: { equals: user.id } },
    } as never)
    const signedIn = await payload.login({
      collection: 'users',
      data: { email: 'pat@example.com', password: PASSWORD },
    })
    expect(signedIn.token).toBeTruthy()
    expect((await userByLegacyId(2)).legacyPasswordHash).toBeNull() // rehashed by Payload
  })

  it('is idempotent against the real database', async () => {
    const summary = await importUsers(false)

    expect(summary.errors).toEqual([])
    expect(summary.importers.organisations).toMatchObject({ created: 0, updated: 4 })
    expect(summary.importers.users).toMatchObject({ created: 0, updated: 8 })
    // Pat has signed in meanwhile: the re-run must not bring the WordPress hash back.
    expect((await userByLegacyId(2)).legacyPasswordHash).toBeNull()
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(8)
  })

  it('a sync refreshes the hash of an unclaimed user and never the claimed one @S-331', async () => {
    const lisa = await userByLegacyId(3)
    const fixtureHash = lisa.legacyPasswordHash as string
    expect(fixtureHash).toMatch(/^\$P\$/)
    await payload.db.updateOne({
      collection: 'users',
      data: { legacyPasswordHash: '$P$Bstale' },
      where: { id: { equals: lisa.id } },
    } as never)

    const plain = await importUsers(false)
    expect(plain.errors).toEqual([])
    expect((await userByLegacyId(3)).legacyPasswordHash).toBe('$P$Bstale') // a normal re-run leaves it

    const dry = await importUsers(true, true)
    expect(dry.importers.users!.refreshed).toBe(1)
    expect((await userByLegacyId(3)).legacyPasswordHash).toBe('$P$Bstale')

    const sync = await importUsers(false, true)
    expect(sync.errors).toEqual([])
    expect(sync.importers.users!.refreshed).toBe(1)
    expect((await userByLegacyId(3)).legacyPasswordHash).toBe(fixtureHash)
    expect((await userByLegacyId(2)).legacyPasswordHash).toBeNull() // Pat signed in: stays consumed
  })

  it('a sync does not re-create a user whose personal data was removed, and keeps them out of this site only @S-331', async () => {
    const lisa = await userByLegacyId(3)
    const before = (await payload.count({ collection: 'users', overrideAccess: true })).totalDocs
    await anonymiseUser({ actorID: lisa.id, payload, userID: lisa.id })

    const sync = await importUsers(false, true)

    expect(sync.errors).toEqual([])
    expect(sync.importers.users).toMatchObject({ created: 0, failed: 0 })
    expect(sync.importers.users!.skipReasons).toMatchObject({ anonymised: 1 })
    expect((await payload.count({ collection: 'users', overrideAccess: true })).totalDocs).toBe(before)
    const row = (await payload.findByID({ collection: 'users', id: lisa.id, depth: 0, overrideAccess: true, showHiddenFields: true })) as unknown as Record<string, any>
    expect(row.legacyId).toBe(3)
    expect(row.removedFromTenants).toBe(String(tenant.id))
    expect(row.email).toMatch(/@removed\.invalid$/)
    expect(row.firstName ?? null).toBeNull()
  })
})
