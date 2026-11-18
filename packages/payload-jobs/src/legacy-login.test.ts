import { postgresAdapter } from '@payloadcms/db-postgres'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { payloadJobs } from './index'

// Real Payload login against Postgres, in its own schema so it cannot clash with other suites.
const databaseUrl = process.env.TEST_DATABASE_URL
const PHPASS = '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0'
const PASSWORD = 'test12345'
const run = Date.now() // unique emails: the schema persists between runs

describe.skipIf(!databaseUrl)('legacy WordPress login through payload.login', () => {
  let payload: Payload

  const addUser = (email: string, legacyPasswordHash: string | null) =>
    payload.db.create({
      collection: 'users',
      data: { email, legacyPasswordHash },
    } as never)

  const legacyHashOf = async (email: string) => {
    const { docs } = await payload.find({
      collection: 'users',
      where: { email: { equals: email } },
      overrideAccess: true,
      showHiddenFields: true,
      depth: 0,
    })
    return docs[0] as unknown as {
      loginAttempts: number
      legacyPasswordHash: string | null
      hash?: string
    }
  }

  beforeAll(async () => {
    const config = await buildConfig({
      secret: 'test-secret',
      auth: { passwordHashIterations: 100000 },
      collections: [
        {
          slug: 'users',
          auth: { maxLoginAttempts: 3, lockTime: 60_000 },
          fields: [],
          versions: false,
        },
      ],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl, max: 5 },
        schemaName: 'legacy_login_test',
        push: true,
      }),
      // This suite only exercises auth: skip the content features, which need media and an editor.
      plugins: [payloadJobs({ features: { pages: false, siteSettings: false }, tenancy: 'single' })],
    })
    payload = await getPayload({ config, key: 'legacy-login-test' })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('logs in with the WordPress password, rehashes it and clears the legacy hash', async () => {
    await addUser(`legacy-${run}@example.com`, PHPASS)

    const first = await payload.login({
      collection: 'users',
      data: { email: `Legacy-${run}@Example.com`, password: PASSWORD },
    })
    expect(first.token).toBeTruthy()

    const stored = await legacyHashOf(`legacy-${run}@example.com`)
    expect(stored.legacyPasswordHash).toBeNull()

    // Now an ordinary Payload user: the same password still works, the legacy path is gone.
    const second = await payload.login({
      collection: 'users',
      data: { email: `legacy-${run}@example.com`, password: PASSWORD },
    })
    expect(second.token).toBeTruthy()
  })

  it('keeps the legacy hash on a wrong password and counts it toward lockout', async () => {
    await addUser(`lockme-${run}@example.com`, PHPASS)
    const attempt = () =>
      payload.login({ collection: 'users', data: { email: `lockme-${run}@example.com`, password: 'nope' } })

    await expect(attempt()).rejects.toThrow()
    expect((await legacyHashOf(`lockme-${run}@example.com`)).loginAttempts).toBe(1)
    expect((await legacyHashOf(`lockme-${run}@example.com`)).legacyPasswordHash).toBe(PHPASS)

    await expect(attempt()).rejects.toThrow()
    await expect(attempt()).rejects.toThrow()

    // Locked: even the right password is refused, and the legacy hash is not consumed.
    await expect(
      payload.login({ collection: 'users', data: { email: `lockme-${run}@example.com`, password: PASSWORD } }),
    ).rejects.toThrow()
    expect((await legacyHashOf(`lockme-${run}@example.com`)).legacyPasswordHash).toBe(PHPASS)
  })

  it('imported user → reset: the old WordPress password is rejected and the new one works', async () => {
    const email = `reset-${run}@example.com`
    await addUser(email, PHPASS)

    const token = await payload.forgotPassword({
      collection: 'users',
      data: { email },
      disableEmail: true,
    })
    await payload.resetPassword({
      collection: 'users',
      data: { password: 'brand-new-pass', token },
      overrideAccess: true,
    })

    expect((await legacyHashOf(email)).legacyPasswordHash).toBeNull()
    await expect(
      payload.login({ collection: 'users', data: { email, password: PASSWORD } }),
    ).rejects.toThrow()
    const ok = await payload.login({ collection: 'users', data: { email, password: 'brand-new-pass' } })
    expect(ok.token).toBeTruthy()
  })

  it('clears the legacy hash when the password is changed through update', async () => {
    const email = `change-${run}@example.com`
    const created = await payload.create({ collection: 'users', data: { email, password: 'first-pass' }, overrideAccess: true })
    // A stale WordPress hash somehow present next to a usable Payload password.
    await payload.db.updateOne({
      collection: 'users',
      id: created.id,
      data: { legacyPasswordHash: PHPASS },
    } as never)

    await payload.update({
      collection: 'users',
      id: created.id,
      data: { password: 'second-pass' },
      user: { ...created, collection: 'users' },
      overrideAccess: false,
    })

    expect((await legacyHashOf(email)).legacyPasswordHash).toBeNull()
    await expect(
      payload.login({ collection: 'users', data: { email, password: PASSWORD } }),
    ).rejects.toThrow()
    expect(
      (await payload.login({ collection: 'users', data: { email, password: 'second-pass' } })).token,
    ).toBeTruthy()
  })

  it('ignores a stale legacy hash for users who already have a Payload password', async () => {
    const email = `stale-${run}@example.com`
    const created = await payload.create({ collection: 'users', data: { email, password: 'real-pass' }, overrideAccess: true })
    await payload.db.updateOne({
      collection: 'users',
      id: created.id,
      data: { legacyPasswordHash: PHPASS },
    } as never)

    // The old WordPress password must not log in, nor overwrite the real password.
    await expect(
      payload.login({ collection: 'users', data: { email, password: PASSWORD } }),
    ).rejects.toThrow()
    expect(
      (await payload.login({ collection: 'users', data: { email, password: 'real-pass' }, overrideAccess: true })).token,
    ).toBeTruthy()
  })

  it('is hidden from the API: no one can read or write the field', () => {
    const field = payload.collections.users.config.fields.find(
      (f) => 'name' in f && f.name === 'legacyPasswordHash',
    ) as { access: Record<'create' | 'read' | 'update', () => boolean>; admin: { hidden: boolean } }
    expect(field.admin.hidden).toBe(true)
    expect(field.access.read()).toBe(false)
    expect(field.access.create()).toBe(false)
    expect(field.access.update()).toBe(false)
  })
})
