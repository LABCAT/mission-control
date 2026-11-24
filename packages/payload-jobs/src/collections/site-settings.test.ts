import { describe, expect, it } from 'vitest'

import {
  enforceOneSiteSettings,
  removeTenantSiteSettings,
  seedTenantSiteSettings,
  siteSettingsCollection,
  validateLang,
} from './site-settings'

type Field = Record<string, any>

const fieldNamed = (collection: ReturnType<typeof siteSettingsCollection>, name: string): Field => {
  const found = (collection.fields as Field[]).find((field) => field.name === name)
  if (!found) throw new Error(`no field ${name}`)
  return found
}

const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

describe('site settings collection @S-263', () => {
  it('is one document per site, named in the admin by the site name', () => {
    const collection = siteSettingsCollection()

    expect(collection.slug).toBe('site-settings')
    expect(collection.admin).toMatchObject({ group: 'Settings', useAsTitle: 'siteName' })
    expect(collection.versions).toBe(false)
    expect(collection.indexes).toEqual([{ fields: ['tenant'], unique: true }])
  })

  it('holds the site chrome: name, logo, tagline, footer, language and banner', () => {
    const collection = siteSettingsCollection()

    expect((collection.fields as Field[]).map((field) => field.name)).toEqual([
      'siteName',
      'logo',
      'tagline',
      'footerText',
      'lang',
      'headerBanner',
      'legacyId',
    ])
    expect(fieldNamed(collection, 'logo')).toMatchObject({ relationTo: 'media', type: 'upload' })
    expect(fieldNamed(collection, 'lang')).toMatchObject({ defaultValue: 'en', type: 'text' })
  })

  it('offers exactly one banner, from the host’s registered block', () => {
    const collection = siteSettingsCollection({ bannerBlockSlugs: ['banner'] })

    expect(fieldNamed(collection, 'headerBanner')).toMatchObject({
      blocks: ['banner'],
      maxRows: 1,
      type: 'blocks',
    })
  })

  it('drops the banner and the logo when the host has neither', () => {
    const collection = siteSettingsCollection({ bannerBlockSlugs: [], mediaSlug: null })

    expect((collection.fields as Field[]).map((field) => field.name)).toEqual([
      'siteName',
      'tagline',
      'footerText',
      'lang',
      'legacyId',
    ])
  })

  it('indexes legacyId so the import can match the settings it made', () => {
    expect(fieldNamed(siteSettingsCollection(), 'legacyId')).toMatchObject({ index: true, type: 'number' })
  })

  it('scopes reads to signed-in users and writes to a site manager', () => {
    const collection = siteSettingsCollection()
    const read = collection.access!.read as (args: unknown) => unknown
    const create = collection.access!.create as (args: unknown) => unknown

    const seeker = { id: 1, tenants: [{ role: 'seeker', tenant: 1 }] }
    const manager = { id: 2, tenants: [{ role: 'site-manager', tenant: 1 }] }

    expect(read({ req: { user: null } })).toBe(false)
    expect(read({ req: { user: seeker } })).toBe(false)
    expect(read({ req: { user: manager } })).toBe(true)
    expect(create({ req: { user: null } })).toBe(false)
    expect(create({ req: { user: seeker } })).toBe(false)
  })

  it('has no tenant index in single-tenant mode', () => {
    expect(siteSettingsCollection({ tenantScoped: false }).indexes).toEqual([])
  })
})

describe('site settings language @S-263', () => {
  it('accepts a language tag', () => {
    for (const value of ['en', 'fr', 'en-VU', 'zh-Hant']) expect(validateLang(value)).toBe(true)
  })

  it('accepts an empty value, which falls back to the default', () => {
    expect(validateLang('')).toBe(true)
    expect(validateLang(undefined)).toBe(true)
    expect(validateLang(null)).toBe(true)
  })

  it('refuses a language name', () => {
    expect(validateLang('English (Vanuatu)')).toMatch(/language tag/)
  })
})

describe('one settings document per site @S-263', () => {
  const hook = enforceOneSiteSettings({ slug: 'site-settings' })

  const run = async ({ count = 0, data = { tenant: 3 } as Record<string, unknown>, operation = 'create' } = {}) => {
    const calls: unknown[] = []
    await hook({
      data,
      operation,
      req: {
        payload: {
          count: async (args: unknown) => {
            calls.push(args)
            return { totalDocs: count }
          },
        },
      },
    } as never)
    return calls
  }

  it('lets the first settings document for a site through', async () => {
    await expect(run()).resolves.toEqual([
      expect.objectContaining({ where: { tenant: { equals: 3 } } }),
    ])
  })

  it('refuses a second settings document for the same site', async () => {
    const error = await run({ count: 1 }).catch((caught: unknown) => caught)

    expect(fieldMessages(error)).toMatch(/already has settings/)
  })

  it('does not police updates, so a site can edit its settings', async () => {
    await expect(run({ count: 1, operation: 'update' })).resolves.toEqual([])
  })

  it('does nothing without a tenant, as in single-tenant mode', async () => {
    await expect(run({ data: {} })).resolves.toEqual([])
  })
})

describe('site settings seeding and cleanup @S-263', () => {
  it('gives a new site its settings document', async () => {
    const created: unknown[] = []
    await seedTenantSiteSettings({ collectionSlug: 'site-settings' })({
      doc: { id: 7 },
      operation: 'create',
      req: {
        payload: {
          count: async () => ({ totalDocs: 0 }),
          create: async (args: unknown) => created.push(args),
        },
      },
    } as never)

    expect(created).toEqual([
      {
        collection: 'site-settings',
        data: { lang: 'en', tenant: 7 },
        overrideAccess: true,
        req: expect.anything(),
      },
    ])
  })

  it('leaves a site that already has settings alone', async () => {
    const created: unknown[] = []
    await seedTenantSiteSettings()({
      doc: { id: 7 },
      operation: 'create',
      req: {
        payload: {
          count: async () => ({ totalDocs: 1 }),
          create: async (args: unknown) => created.push(args),
        },
      },
    } as never)

    expect(created).toEqual([])
  })

  it('never seeds the aggregate tenant', async () => {
    const created: unknown[] = []
    await seedTenantSiteSettings()({
      doc: { id: 7, isAggregate: true },
      operation: 'create',
      req: {
        payload: {
          count: async () => ({ totalDocs: 0 }),
          create: async (args: unknown) => created.push(args),
        },
      },
    } as never)

    expect(created).toEqual([])
  })

  it('does nothing in single-tenant mode', async () => {
    const created: unknown[] = []
    await seedTenantSiteSettings({ tenantScoped: false })({
      doc: { id: 7 },
      operation: 'create',
      req: {
        payload: {
          count: async () => ({ totalDocs: 0 }),
          create: async (args: unknown) => created.push(args),
        },
      },
    } as never)

    expect(created).toEqual([])
  })

  it('deletes a tenant’s settings before the tenant row goes', async () => {
    const deleted: unknown[] = []
    await removeTenantSiteSettings({ collectionSlug: 'site-settings' })({
      id: 7,
      req: { payload: { delete: async (args: unknown) => deleted.push(args) } },
    } as never)

    expect(deleted).toEqual([
      {
        collection: 'site-settings',
        overrideAccess: true,
        req: expect.anything(),
        where: { tenant: { equals: 7 } },
      },
    ])
  })
})
