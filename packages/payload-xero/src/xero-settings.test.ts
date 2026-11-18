import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type TestHarness, bootTestPayload, tenantIsolation } from './test'
import {
  DUPLICATE_TENANT_MESSAGE,
  XeroSettings,
  isUniqueViolation,
  mapDuplicateTenantError,
  mapUniqueViolation,
} from './xero-settings'

tenantIsolation({
  collection: XeroSettings,
  createData: (tenant) => ({ xeroTenantId: `xero-org-${tenant.slug}` }),
})

describe('xero-settings access and rules', () => {
  let harness: TestHarness
  let editor: { collection: string; id: number; role: 'user'; tenants: { role: string; tenant: number }[] }

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: [XeroSettings] })

    const email = `editor-${harness.tenantA.slug}@example.invalid`
    const doc = (await harness.payload.create({
      collection: 'users',
      data: {
        email,
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
      await harness.payload.delete({
        collection: 'users',
        id: editor.id,
        overrideAccess: true,
      })
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
    ).rejects.toThrow()
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

  it('hides settings from editors, anonymous callers and other tenants’ admins', async () => {
    const asEditor = await harness.payload
      .find({ collection: 'xero-settings', user: editor as never })
      .catch(() => ({ docs: [] }))
    expect(asEditor.docs).toHaveLength(0)

    await expect(
      harness.payload.find({ collection: 'xero-settings', overrideAccess: false }),
    ).rejects.toThrow()

    const asB = await harness.payload.find({
      collection: 'xero-settings',
      user: harness.tenantAdminB as never,
    })
    expect(asB.docs.every((d) => String((d as unknown as { tenant: unknown }).tenant).includes(String(harness.tenantB.id)))).toBe(true)
  })

  it('stops an editor from writing settings', async () => {
    await expect(
      harness.payload.create({
        collection: 'xero-settings',
        data: { tenant: harness.tenantA.id, xeroTenantId: 'x' },
        user: editor as never,
      }),
    ).rejects.toThrow()
  })
})

const run = (error: unknown) =>
  (mapDuplicateTenantError as (args: never) => unknown)({ error } as never)

describe('one settings row per tenant is enforced by a unique index', () => {
  it('declares a unique index on tenant', () => {
    expect(XeroSettings.indexes).toContainEqual({ fields: ['tenant'], unique: true })
  })

  it('maps unique violations, including wrapped ones, to the clear error', () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    const wrapped = new Error('Failed query', { cause: pgError })

    for (const error of [pgError, wrapped]) {
      expect(mapUniqueViolation(error)).toMatchObject({ message: DUPLICATE_TENANT_MESSAGE })
    }

    const other = Object.assign(new Error('boom'), { code: '23503' })
    expect(mapUniqueViolation(other)).toBe(other)
    expect(mapUniqueViolation('x')).toBe('x')
  })

  it('rewrites the API error response for a unique violation only', async () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' })
    expect(await run(pgError)).toEqual({
      response: { errors: [{ message: DUPLICATE_TENANT_MESSAGE }] },
      status: 400,
    })
    expect(await run(new Error('other'))).toBeUndefined()
  })

  describe('against Postgres', () => {
    let harness: TestHarness

    beforeAll(async () => {
      harness = await bootTestPayload({ collections: [XeroSettings] })
    })
    afterAll(async () => {
      if (harness) await harness.destroy()
    })

    it('lets only one of two concurrent creates for a tenant succeed', async () => {
      const results = await Promise.allSettled(
        ['one', 'two'].map((id) =>
          harness.payload.create({
            collection: 'xero-settings',
            data: { tenant: harness.tenantA.id, xeroTenantId: id },
            user: harness.tenantAdminA as never,
          }),
        ),
      )
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      // Either the hook or the index stopped it; both surface as a mappable error.
      const mapped = mapUniqueViolation(rejected[0].reason) as Error
      expect(mapped.message === DUPLICATE_TENANT_MESSAGE || isUniqueViolation(rejected[0].reason)).toBe(true)
    })
  })
})
