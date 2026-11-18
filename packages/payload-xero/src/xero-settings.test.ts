import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type TestHarness, bootTestPayload, tenantIsolation } from './test'
import { XeroSettings } from './xero-settings'

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
