import type { AccessArgs, CollectionConfig, Field, TextField } from 'payload'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MissionControlUser } from './access'
import { bootTestPayload, tenantIsolation, type TestHarness } from './test'
import {
  TAXONOMY_EDITOR_ROLES,
  TAXONOMY_SLUGS,
  taxonomyCollection,
  taxonomyCollections,
  uniqueSlugPerTenant,
  validateTaxonomySlug,
} from './taxonomies'

const fieldNamed = (collection: CollectionConfig, name: string): Field => {
  const field = collection.fields.find(
    (candidate) => 'name' in candidate && candidate.name === name,
  )
  if (!field) throw new Error(`${collection.slug} is missing ${name}`)
  return field
}

const userWith = (
  tenants: { role: 'editor' | 'employer' | 'tenant-admin'; tenant: number }[],
  role: 'super-admin' | 'user' = 'user',
): MissionControlUser => ({ id: 1, role, tenants })

const argsFor = (user: MissionControlUser | null, data?: Record<string, unknown>) =>
  ({ data, req: { user } }) as unknown as AccessArgs

describe('taxonomy collection config', () => {
  const collections = taxonomyCollections()
  const bySlug = new Map(collections.map((collection) => [collection.slug, collection]))

  it('defines every job-board taxonomy exactly once', () => {
    expect(collections.map((collection) => collection.slug)).toEqual([...TAXONOMY_SLUGS])
    expect(new Set(collections.map((collection) => collection.slug)).size).toBe(
      TAXONOMY_SLUGS.length,
    )
  })

  it('gives each taxonomy a localized name, a slug and an indexed legacyId', () => {
    for (const collection of collections) {
      const name = fieldNamed(collection, 'name') as TextField
      const slug = fieldNamed(collection, 'slug') as TextField
      const legacyId = fieldNamed(collection, 'legacyId') as TextField

      expect(name).toMatchObject({ localized: true, required: true, type: 'text' })
      expect(slug).toMatchObject({ required: true, type: 'text' })
      expect(slug.validate).toBe(validateTaxonomySlug)
      // The unique index spans the tenant, so the column itself is not unique.
      expect(slug.unique).toBeFalsy()
      expect(legacyId).toMatchObject({ index: true, type: 'number' })
      expect(legacyId.required).toBeFalsy()
    }
  })

  it('makes the slug unique per tenant and not across tenants', () => {
    for (const collection of collections) {
      expect(collection.indexes).toEqual([{ fields: ['tenant', 'slug'], unique: true }])
    }
  })

  it('adds isVolunteer to job types only, defaulting to false', () => {
    const jobTypes = bySlug.get('job-types')
    if (!jobTypes) throw new Error('Missing job-types')

    expect(fieldNamed(jobTypes, 'isVolunteer')).toMatchObject({
      defaultValue: false,
      type: 'checkbox',
    })

    for (const collection of collections.filter((candidate) => candidate.slug !== 'job-types')) {
      expect(collection.fields.some((field) => 'name' in field && field.name === 'isVolunteer')).toBe(
        false,
      )
    }
  })

  it('skips versions so Payload does not create _v tables', () => {
    for (const collection of collections) expect(collection.versions).toBe(false)
  })

  it('drops the tenant scope and the compound index in single-tenant mode', () => {
    const single = taxonomyCollections({ tenantScoped: false })

    for (const collection of single) {
      const slug = fieldNamed(collection, 'slug') as TextField

      expect(collection.indexes).toEqual([])
      expect(slug.unique).toBe(true)
    }
  })
})

describe('taxonomy slug validation', () => {
  it('accepts lowercase slugs and rejects anything else', () => {
    expect(validateTaxonomySlug('hospitality-tourism')).toBe(true)
    expect(validateTaxonomySlug('it')).toBe(true)
    expect(validateTaxonomySlug('2026')).toBe(true)
    expect(validateTaxonomySlug('Hospitality')).toMatch(/lowercase/)
    expect(validateTaxonomySlug('hospitality tourism')).toMatch(/lowercase/)
    expect(validateTaxonomySlug('hospitality--tourism')).toMatch(/lowercase/)
    expect(validateTaxonomySlug('-tourism')).toMatch(/lowercase/)
    expect(validateTaxonomySlug('')).toMatch(/lowercase/)
    expect(validateTaxonomySlug(undefined)).toMatch(/lowercase/)
  })
})

describe('taxonomy access control', () => {
  const collection = taxonomyCollection({
    labels: { plural: 'Job categories', singular: 'Job category' },
    slug: 'job-categories',
  })
  const read = collection.access?.read
  const write = collection.access?.create
  if (!read || !write) throw new Error('Missing taxonomy access functions')

  it('keeps anonymous reads closed; public sites read through a site key', async () => {
    expect(await read(argsFor(null))).toBe(false)
    expect(await read(argsFor(userWith([])))).toBe(true)
  })

  it('lets tenant-admins and editors write inside their own tenants only', async () => {
    const tenantAdmin = userWith([{ role: 'tenant-admin', tenant: 10 }])
    const editor = userWith([{ role: 'editor', tenant: 20 }])

    expect(await write(argsFor(tenantAdmin))).toEqual({ tenant: { in: [10] } })
    expect(await write(argsFor(editor))).toEqual({ tenant: { in: [20] } })
    expect(await write(argsFor(tenantAdmin, { slug: 'it', tenant: 10 }))).toEqual({
      tenant: { in: [10] },
    })
    expect(await write(argsFor(tenantAdmin, { slug: 'it', tenant: 20 }))).toBe(false)
  })

  it('denies employers, users with no tenant role and anonymous callers', async () => {
    expect(await write(argsFor(userWith([{ role: 'employer', tenant: 10 }])))).toBe(false)
    expect(await write(argsFor(userWith([])))).toBe(false)
    expect(await write(argsFor(null))).toBe(false)
  })

  it('lets a super-admin write any tenant without a scope', async () => {
    const superAdmin = userWith([], 'super-admin')

    expect(await write(argsFor(superAdmin))).toBe(true)
    expect(await write(argsFor(superAdmin, { slug: 'it', tenant: 99 }))).toBe(true)
  })

  it('uses the editor roles for every taxonomy', async () => {
    expect([...TAXONOMY_EDITOR_ROLES]).toEqual(['tenant-admin', 'editor'])
  })
})

const requestWith = (docs: { id: number }[]) => {
  const find = vi.fn(async () => ({ docs }))
  return { find, req: { payload: { find } } as never }
}

describe('unique slug per tenant hook', () => {
  const hook = uniqueSlugPerTenant('job-categories')

  it('passes when no other document in the tenant uses the slug', async () => {
    const { find, req } = requestWith([])

    await expect(
      hook({ data: { slug: 'it', tenant: 10 }, originalDoc: undefined, req } as never),
    ).resolves.toEqual({ slug: 'it', tenant: 10 })

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'job-categories',
        overrideAccess: true,
        where: { and: [{ slug: { equals: 'it' } }, { tenant: { equals: 10 } }] },
      }),
    )
  })

  it('rejects a slug already used by another document in the same tenant', async () => {
    const { req } = requestWith([{ id: 7 }])

    const error = await hook({
      data: { slug: 'it', tenant: 10 },
      originalDoc: undefined,
      req,
    } as never).catch((thrown: unknown) => thrown)

    expect(error).toMatchObject({
      data: { errors: [{ message: 'Slug "it" is already used in this tenant', path: 'slug' }] },
    })
  })

  it('allows a document to keep its own slug on update', async () => {
    const { req } = requestWith([{ id: 7 }])

    await expect(
      hook({ data: { slug: 'it' }, originalDoc: { id: 7, tenant: 10 }, req } as never),
    ).resolves.toEqual({ slug: 'it' })
  })

  it('skips the lookup when the slug or the tenant is missing', async () => {
    const { find, req } = requestWith([])

    await expect(hook({ data: { tenant: 10 }, req } as never)).resolves.toEqual({ tenant: 10 })
    await expect(hook({ data: { slug: 'it' }, req } as never)).resolves.toEqual({ slug: 'it' })
    expect(find).not.toHaveBeenCalled()
  })
})

describe('taxonomy integration', () => {
  const jobsCategories = taxonomyCollections()[0]
  if (!jobsCategories) throw new Error('Missing job-categories')

  tenantIsolation({
    collection: jobsCategories,
    createData: () => ({ name: 'Automotive', slug: 'automotive' }),
  })

  describe('per-tenant slug uniqueness and volunteer flag', () => {
    let harness: TestHarness

    beforeEach(async () => {
      harness = await bootTestPayload({
        collections: taxonomyCollections({ tenantScoped: true }),
      })
    })

    afterEach(async () => {
      if (harness) await harness.destroy()
    })

    const createCategory = (
      tenant: number,
      data: Record<string, unknown>,
      user?: MissionControlUser,
    ) =>
      harness.payload.create({
        collection: 'job-categories',
        data: { ...data, tenant } as never,
        ...(user ? { user: user as never } : { overrideAccess: true }),
      })

    it('allows the same slug on two tenants but rejects a duplicate within one', async () => {
      await createCategory(harness.tenantA.id, { name: 'IT', slug: 'it' })
      await expect(createCategory(harness.tenantB.id, { name: 'IT', slug: 'it' })).resolves.toMatchObject({
        slug: 'it',
      })

      await expect(createCategory(harness.tenantA.id, { name: 'More IT', slug: 'it' })).rejects.toThrow()
    })

    it('stores isVolunteer on job types, defaulting to false', async () => {
      const paid = await harness.payload.create({
        collection: 'job-types',
        data: { name: 'Full-Time', slug: 'full-time', tenant: harness.tenantA.id } as never,
        overrideAccess: true,
      })
      const volunteer = await harness.payload.create({
        collection: 'job-types',
        data: {
          isVolunteer: true,
          name: 'Voluntary',
          slug: 'voluntary',
          tenant: harness.tenantA.id,
        } as never,
        overrideAccess: true,
      })

      expect(paid).toMatchObject({ isVolunteer: false })
      expect(volunteer).toMatchObject({ isVolunteer: true })
    })

    it('keeps the WordPress term id for the import', async () => {
      const legacy = await harness.payload.create({
        collection: 'salary-bands',
        data: { legacyId: 98, name: 'VT 50,000–100,000', slug: 'vt-50000', tenant: harness.tenantA.id } as never,
        overrideAccess: true,
      })

      expect(legacy).toMatchObject({ legacyId: 98 })
    })

    it('lets a tenant-admin create a taxonomy in their tenant and not in another', async () => {
      await expect(
        harness.payload.create({
          collection: 'job-tags',
          data: { name: 'NGO', slug: 'ngo', tenant: harness.tenantA.id } as never,
          user: harness.tenantAdminA as never,
        }),
      ).resolves.toMatchObject({ slug: 'ngo' })

      await expect(
        harness.payload.create({
          collection: 'job-tags',
          data: { name: 'NGO', slug: 'ngo-b', tenant: harness.tenantB.id } as never,
          user: harness.tenantAdminA as never,
        }),
      ).rejects.toThrow()
    })

    it('rejects an employer write', async () => {
      const employer = await harness.payload.create({
        collection: 'users',
        data: {
          email: `employer-${harness.tenantA.id}@example.invalid`,
          password: 'test-password',
          role: 'user',
          tenants: [{ role: 'employer', tenant: harness.tenantA.id }],
        } as never,
        overrideAccess: true,
      })

      await expect(
        harness.payload.create({
          collection: 'areas-of-focus',
          data: { name: 'Youth', slug: 'youth', tenant: harness.tenantA.id } as never,
          user: employer as never,
        }),
      ).rejects.toThrow()

      // The same tenant's admin is allowed, so the rejection above is the role, not the tenant.
      await expect(
        harness.payload.create({
          collection: 'areas-of-focus',
          data: { name: 'Youth', slug: 'youth-admin', tenant: harness.tenantA.id } as never,
          user: harness.tenantAdminA as never,
        }),
      ).resolves.toMatchObject({ slug: 'youth-admin' })
    })
  })
})
