import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  type GlobalHarness,
  type TestHarness,
  bootGlobalTestPayload,
  bootTestPayload,
  tenantIsolation,
} from './test'
import { tenantAdminAccess } from './test/roles'
import {
  authenticatedAdminAccess,
  buildXeroSettingsCollection,
  duplicateMessage,
  isUniqueViolation,
  mapDuplicateError,
  mapUniqueViolation,
} from './xero-settings'

const tenantAdminRules = {
  create: tenantAdminAccess,
  delete: tenantAdminAccess,
  read: tenantAdminAccess,
  update: tenantAdminAccess,
}

const TenantSettings = buildXeroSettingsCollection({ access: tenantAdminRules, scope: 'tenant' })
const GlobalSettings = buildXeroSettingsCollection({ scope: 'global' })

tenantIsolation({
  collection: TenantSettings,
  createData: (tenant) => ({ xeroTenantId: `xero-org-${tenant.slug}` }),
})

describe('collection config', () => {
  it('declares a unique tenant index in tenant scope and a unique singleton in global scope', () => {
    expect(TenantSettings.indexes).toContainEqual({ fields: ['tenant'], unique: true })
    expect(TenantSettings.fields.some((f) => 'name' in f && f.name === 'singleton')).toBe(false)

    expect(GlobalSettings.indexes).toBeUndefined()
    expect(GlobalSettings.fields).toContainEqual(
      expect.objectContaining({ name: 'singleton', unique: true }),
    )
  })

  it('honours a custom slug and tenant field', () => {
    const custom = buildXeroSettingsCollection({
      scope: 'tenant',
      settingsSlug: 'accounting-xero',
      tenantField: 'organisation',
    })

    expect(custom.slug).toBe('accounting-xero')
    expect(custom.indexes).toContainEqual({ fields: ['organisation'], unique: true })
    expect(custom.versions).toBe(false)
  })

  it('keeps the token group hidden and carries the refresh lease columns', () => {
    const tokens = TenantSettings.fields.find((field) => 'name' in field && field.name === 'tokens')

    expect(tokens).toMatchObject({ admin: { hidden: true }, type: 'group' })
    expect(
      tokens && 'fields' in tokens && tokens.fields.map((field) => 'name' in field && field.name),
    ).toEqual(
      expect.arrayContaining([
        'accessToken',
        'expiresAt',
        'refreshToken',
        'scope',
        // The single-flight refresh lease: one request owns the row while it refreshes.
        'refreshLockToken',
        'refreshLockedUntil',
      ]),
    )

    const access = (tokens as { access?: Record<string, unknown> } | undefined)?.access ?? {}
    for (const operation of ['create', 'read', 'update'] as const) {
      expect(access[operation]).toBeTypeOf('function')
      expect((access[operation] as () => boolean)()).toBe(false)
    }
  })
})

describe('unique violation mapping', () => {
  const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })

  it('maps direct and wrapped violations to the scope’s clear message', () => {
    for (const error of [pgError, new Error('Failed query', { cause: pgError })]) {
      expect(isUniqueViolation(error)).toBe(true)
      expect(mapUniqueViolation(error, 'tenant')).toMatchObject({ message: duplicateMessage('tenant') })
      expect(mapUniqueViolation(error, 'global')).toMatchObject({ message: duplicateMessage('global') })
    }

    expect(duplicateMessage('tenant')).not.toBe(duplicateMessage('global'))
  })

  it('leaves other errors alone', () => {
    const other = Object.assign(new Error('boom'), { code: '23503' })

    expect(mapUniqueViolation(other)).toBe(other)
    expect(mapUniqueViolation('x')).toBe('x')
  })

  it('rewrites the API error response for a unique violation only', async () => {
    const hook = mapDuplicateError('tenant') as (args: never) => unknown

    expect(await hook({ error: pgError } as never)).toEqual({
      response: { errors: [{ message: duplicateMessage('tenant') }] },
      status: 400,
    })
    expect(await hook({ error: new Error('other') } as never)).toBeUndefined()
  })
})

describe('tenant scope: access and rules', () => {
  let harness: TestHarness
  let editor: { collection: string; id: number; role: 'user'; tenants: { role: string; tenant: number }[] }

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: [TenantSettings] })

    const doc = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `editor-${harness.tenantA.slug}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants: [{ role: 'editor', tenant: harness.tenantA.id }],
      },
      overrideAccess: true,
    })) as { id: number }
    editor = {
      collection: 'users',
      id: doc.id,
      role: 'user',
      tenants: [{ role: 'editor', tenant: harness.tenantA.id }],
    }
  })

  afterAll(async () => {
    if (harness) {
      await harness.payload.delete({ collection: 'users', id: editor.id, overrideAccess: true })
      await harness.destroy()
    }
  })

  it('applies defaults and stores the configured fields', async () => {
    const doc = (await harness.payload.create({
      collection: 'xero-settings',
      data: {
        accountCodes: { discount: '260', plan: '200' },
        brandingThemeId: 'theme-1',
        reconciliationAccountCode: '090',
        tenant: harness.tenantA.id,
        trackingCategory: { name: 'Region', option: 'Vanuatu' },
        xeroTenantId: 'org-a',
      },
      user: harness.tenantAdminA as never,
    })) as Record<string, any>

    expect(doc.dueDays).toBe(14)
    expect(doc.accountCodes).toMatchObject({ discount: '260', plan: '200' })
    expect(doc.trackingCategory).toMatchObject({ name: 'Region', option: 'Vanuatu' })
  })

  it('allows only one settings row per tenant', async () => {
    await expect(
      harness.payload.create({
        collection: 'xero-settings',
        data: { tenant: harness.tenantA.id, xeroTenantId: 'duplicate' },
        user: harness.tenantAdminA as never,
      }),
    ).rejects.toThrow(duplicateMessage('tenant'))
  })

  it('lets only one of two concurrent creates for a tenant succeed', async () => {
    const results = await Promise.allSettled(
      ['one', 'two'].map((id) =>
        harness.payload.create({
          collection: 'xero-settings',
          data: { tenant: harness.tenantB.id, xeroTenantId: id },
          user: harness.tenantAdminB as never,
        }),
      ),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })

  it('rejects out-of-range due days', async () => {
    await expect(
      harness.payload.create({
        collection: 'xero-settings',
        data: { dueDays: -1, tenant: harness.tenantB.id },
        user: harness.tenantAdminB as never,
      }),
    ).rejects.toThrow()
  })

  it('applies the app’s access rules: editors and anonymous callers get nothing', async () => {
    const asEditor = await harness.payload
      .find({ collection: 'xero-settings', user: editor as never })
      .catch(() => ({ docs: [] }))
    expect(asEditor.docs).toHaveLength(0)

    await expect(
      harness.payload.find({ collection: 'xero-settings', overrideAccess: false }),
    ).rejects.toThrow()

    await expect(
      harness.payload.create({
        collection: 'xero-settings',
        data: { tenant: harness.tenantA.id, xeroTenantId: 'x' },
        user: editor as never,
      }),
    ).rejects.toThrow()
  })
})

describe('global scope: concurrent creates with different singleton values', () => {
  let harness: GlobalHarness

  beforeAll(async () => {
    harness = await bootGlobalTestPayload({ collections: [GlobalSettings] })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('lets exactly one succeed', async () => {
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((value) =>
        harness.payload.create({
          collection: 'xero-settings',
          data: { singleton: value, xeroTenantId: value },
          user: harness.admin as never,
        }),
      ),
    )

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)

    const { totalDocs } = await harness.payload.find({
      collection: 'xero-settings',
      user: harness.admin as never,
    })
    expect(totalDocs).toBe(1)
  })
})

describe('global scope: no tenant, one row, default access', () => {
  let harness: GlobalHarness

  beforeAll(async () => {
    harness = await bootGlobalTestPayload({ collections: [GlobalSettings] })
  })

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('has no tenant field and stores the settings', async () => {
    const doc = (await harness.payload.create({
      collection: 'xero-settings',
      data: { accountCodes: { plan: '200' }, xeroTenantId: 'org-global' },
      user: harness.admin as never,
    })) as Record<string, any>

    expect('tenant' in doc).toBe(false)
    expect(doc.singleton).toBe('xero')
    expect(doc.dueDays).toBe(14)
  })

  it('allows only one row', async () => {
    await expect(
      harness.payload.create({
        collection: 'xero-settings',
        data: { xeroTenantId: 'second' },
        user: harness.admin as never,
      }),
    ).rejects.toThrow(duplicateMessage('global'))
  })

  it('ignores a client-supplied singleton value on create and update', async () => {
    const results = await Promise.allSettled(
      ['a', 'b', 'c'].map((value) =>
        harness.payload.create({
          collection: 'xero-settings',
          data: { singleton: value, xeroTenantId: value },
          user: harness.admin as never,
        }),
      ),
    )
    expect(results.every((r) => r.status === 'rejected')).toBe(true)

    const { docs } = await harness.payload.find({ collection: 'xero-settings', user: harness.admin as never })
    const updated = (await harness.payload.update({
      collection: 'xero-settings',
      data: { singleton: 'other', dueDays: 21 },
      id: docs[0].id,
      user: harness.admin as never,
    })) as Record<string, any>

    expect(updated.singleton).toBe('xero')
    expect(updated.dueDays).toBe(21)
  })

  it('enforces the single row in the database too, bypassing the hook', async () => {
    // A direct drizzle insert skips Payload hooks; the unique column still stops it.
    const { pool } = harness.payload.db as unknown as {
      pool: { query: (text: string) => Promise<unknown> }
    }

    const attempt = pool.query(
      "insert into payload_xero_global_test.xero_settings (singleton, updated_at, created_at) values ('xero', now(), now())",
    )

    await expect(attempt).rejects.toSatisfy(isUniqueViolation)
  })

  it('default access: admin-capable users in, other authenticated users and anonymous out', async () => {
    const asAdmin = await harness.payload.find({
      collection: 'xero-settings',
      user: harness.admin as never,
    })
    expect(asAdmin.docs).toHaveLength(1)

    await expect(
      harness.payload.find({ collection: 'xero-settings', user: harness.visitor as never, overrideAccess: false }),
    ).rejects.toThrow()
    await expect(
      harness.payload.find({ collection: 'xero-settings', overrideAccess: false }),
    ).rejects.toThrow()
    await expect(
      harness.payload.update({
        collection: 'xero-settings',
        data: { dueDays: 30 },
        user: harness.visitor as never,
        where: { id: { exists: true } },
      }),
    ).rejects.toThrow()
  })

  it('exports the default access as a plain Access function', () => {
    expect(typeof authenticatedAdminAccess).toBe('function')
  })
})
