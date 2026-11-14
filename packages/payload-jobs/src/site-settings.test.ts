import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  siteSettingsCollection,
  siteSettingsGlobal,
  siteSettingsMultiTenantOptions,
} from './site-settings'
import { bootTestPayload, type TestHarness, type TestTenant, type TestUser } from './test'

let harness: TestHarness
let tenantSeq = 0

beforeAll(async () => {
  harness = await bootTestPayload({
    collections: [siteSettingsCollection()],
    globalCollections: ['site-settings'],
    media: true,
  })
}, 120_000)

afterAll(async () => {
  await harness.destroy()
})

type Settings = {
  analyticsId?: string
  footerText?: string
  hero?: { heading?: string; subheading?: string }
  navLinks?: { href?: string; label?: string; openInNewTab?: boolean }[]
  promoBlocks?: { active?: boolean; heading?: string }[]
  tenant?: unknown
}

/**
 * A fresh tenant per test, since a tenant may only have one settings document. Ensuring that
 * invariant means one test cannot leave state another test trips over.
 */
const makeTenant = async (): Promise<{ admin: TestUser; tenant: TestTenant }> => {
  const slug = `settings-tenant-${++tenantSeq}-${Date.now().toString(36)}`
  const tenant = (await harness.payload.create({
    collection: 'tenants',
    data: { name: `Settings ${tenantSeq}`, slug } as never,
    overrideAccess: true,
  })) as TestTenant

  const admin = (await harness.payload.create({
    collection: 'users',
    data: {
      email: `${slug}@example.invalid`,
      password: 'test-password',
      role: 'user',
      tenants: [{ role: 'tenant-admin', tenant: tenant.id }],
    } as never,
    overrideAccess: true,
  })) as TestUser

  return { admin, tenant }
}

/**
 * Payload puts the per-field messages in `error.data.errors`, and only the field labels in the
 * top-level message, so match on the collected messages.
 */
const validationMessages = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
  } catch (error) {
    const data = (error as { data?: { errors?: { message?: string }[] } }).data

    return [String((error as Error).message), ...(data?.errors ?? []).map((e) => e.message ?? '')]
      .join(' | ')
      .toLowerCase()
  }

  throw new Error('Expected the operation to be rejected, but it succeeded')
}

const createSettings = (
  tenant: TestTenant,
  admin: TestUser,
  data: Record<string, unknown> = {},
): Promise<Settings> =>
  harness.payload.create({
    collection: 'site-settings',
    data: { footerText: 'Footer', ...data, tenant: tenant.id } as never,
    user: admin,
  } as never) as Promise<Settings>

describe('site settings', () => {
  it('stores the home page content for a tenant', async () => {
    const { admin, tenant } = await makeTenant()

    const settings = await createSettings(tenant, admin, {
      analyticsId: 'G-ABCDE12345',
      footerText: '© Vanuatu Wok',
      hero: { heading: 'Find work in Vanuatu', subheading: 'Jobs across all islands' },
      navLinks: [
        { href: '/jobs', label: 'Jobs' },
        { href: 'https://vanuatuwok.vu/about', label: 'About', openInNewTab: true },
      ],
      promoBlocks: [
        { active: true, heading: 'Employers' },
        { active: false, heading: 'Job seekers' },
      ],
    })

    expect(settings.hero).toMatchObject({
      heading: 'Find work in Vanuatu',
      subheading: 'Jobs across all islands',
    })
    expect(settings.navLinks).toHaveLength(2)
    expect(settings.navLinks?.[1]).toMatchObject({ openInNewTab: true })
    expect(settings.promoBlocks?.map((block) => block.heading)).toEqual([
      'Employers',
      'Job seekers',
    ])
    expect(settings.footerText).toBe('© Vanuatu Wok')
    expect(settings.analyticsId).toBe('G-ABCDE12345')
  })

  it('accepts a Cloudflare Web Analytics token too', async () => {
    const { admin, tenant } = await makeTenant()

    const settings = await createSettings(tenant, admin, { analyticsId: 'b'.repeat(32) })

    expect(settings.analyticsId).toBe('b'.repeat(32))
  })

  it('refuses a second settings document for the same tenant', async () => {
    const { admin, tenant } = await makeTenant()

    await createSettings(tenant, admin)

    expect(await validationMessages(createSettings(tenant, admin))).toContain(
      'already has site settings',
    )
  })

  it('lets the same admin update the existing settings instead', async () => {
    const { admin, tenant } = await makeTenant()

    const created = await createSettings(tenant, admin, { footerText: 'Old footer' })

    const updated = (await harness.payload.update({
      collection: 'site-settings',
      data: { footerText: 'New footer' },
      id: (created as { id: number }).id,
      user: admin,
    })) as Settings

    expect(updated.footerText).toBe('New footer')
  })

  it('gives each tenant its own settings', async () => {
    const first = await makeTenant()
    const second = await makeTenant()

    const a = await createSettings(first.tenant, first.admin, { footerText: 'Footer A' })
    const b = await createSettings(second.tenant, second.admin, { footerText: 'Footer B' })

    expect(a.footerText).toBe('Footer A')
    expect(b.footerText).toBe('Footer B')
  })

  it('rejects an analytics ID in an unsupported format', async () => {
    const { admin, tenant } = await makeTenant()

    expect(
      await validationMessages(createSettings(tenant, admin, { analyticsId: 'UA-12345-1' })),
    ).toContain('ga4 measurement id')
  })

  it('rejects a nav link that is not a path or an absolute URL', async () => {
    const { admin, tenant } = await makeTenant()

    expect(
      await validationMessages(
        createSettings(tenant, admin, {
          navLinks: [{ href: 'javascript:alert(1)', label: 'Bad' }],
        }),
      ),
    ).toContain('path starting with /')
  })

  it('rejects a promo block without a heading', async () => {
    const { admin, tenant } = await makeTenant()

    await expect(
      createSettings(tenant, admin, { promoBlocks: [{ body: 'No heading' }] }),
    ).rejects.toThrow(/heading/i)
  })

  it('hides a tenant’s settings from another tenant’s admin', async () => {
    const first = await makeTenant()
    const second = await makeTenant()
    await createSettings(first.tenant, first.admin)

    const seenBySecond = await harness.payload.find({
      collection: 'site-settings',
      user: second.admin,
    })

    expect(seenBySecond.totalDocs).toBe(0)
  })

  it('refuses a settings document for another tenant', async () => {
    const first = await makeTenant()
    const second = await makeTenant()

    await expect(
      harness.payload.create({
        collection: 'site-settings',
        data: { tenant: second.tenant.id } as never,
        user: first.admin,
      }),
    ).rejects.toThrow()
  })

  it('lets a super-admin read every tenant’s settings', async () => {
    const { totalDocs: before } = await harness.payload.count({
      collection: 'site-settings',
      overrideAccess: true,
    })

    const first = await makeTenant()
    const second = await makeTenant()
    await createSettings(first.tenant, first.admin)
    await createSettings(second.tenant, second.admin)

    const all = await harness.payload.find({
      collection: 'site-settings',
      overrideAccess: false,
      user: harness.superAdmin,
    })

    expect(all.totalDocs).toBe(before + 2)
  })
})

describe('site settings as a global (single-tenant host)', () => {
  it('exposes the same fields on the global, without a tenant field', () => {
    const global = siteSettingsGlobal()
    const names = global.fields.map((field) => ('name' in field ? field.name : undefined))

    expect(names).toEqual(['hero', 'promoBlocks', 'navLinks', 'footerText', 'analyticsId'])
    expect(names).not.toContain('tenant')
    expect(global.versions).toBe(false)
  })

  it('ships the multi-tenant plugin options that make the tenant unique', () => {
    expect(siteSettingsMultiTenantOptions()).toEqual({ 'site-settings': { isGlobal: true } })
  })
})
