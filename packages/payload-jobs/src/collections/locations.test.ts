import type { CollectionConfig, Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { MENUS_SLUG } from './menus'
import { PAGES_SLUG } from './pages'
import { payloadJobs } from '../index'
import { tenantLocationSettings } from '../location-settings'
import { slugRulesFor } from '../slug-rules'
import { TAXONOMY_SLUGS } from '../taxonomies'
import { locationsCollection, slugifyLocationName } from './locations'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  secret: 'test',
} as unknown as Config

const Locations = locationsCollection()

const fieldNamed = (collection: CollectionConfig, name: string) =>
  collection.fields.find((field) => 'name' in field && field.name === name)

const requestFor = (user: unknown) => ({ req: { user } }) as never

const settingsA = tenantLocationSettings({
  locationLevels: [{ label: 'Island' }, { label: 'Town' }],
  locationMaxDepth: 1,
})
const settingsB = tenantLocationSettings({
  locationLevels: [{ label: 'Region' }, { label: 'City' }, { label: 'Suburb' }],
  locationMaxDepth: 2,
})

const limitedCollection = locationsCollection({
  limits: ({ data }) => {
    const tenant = String(data.tenant)
    if (tenant === '2') return settingsA
    if (tenant === '3') return settingsB

    return null
  },
  requireTenant: true,
})

describe('locations collection @S-120', () => {
  it('is registered by the plugin without touching the host collections', async () => {
    const config = await payloadJobs()(baseConfig)

    expect(config.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      PAGES_SLUG,
      MENUS_SLUG,
      'site-settings',
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
      'jobs',
      'coupons',
      'application-files',
      'applications',
      'orders',
      'credit-ledger',
    ])
    expect(Locations.slug).toBe('locations')
    expect(Locations.versions).toBe(false)
  })

  it('refuses to register twice rather than silently dropping one definition', () => {
    expect(() =>
      payloadJobs()({
        collections: [{ slug: 'users', fields: [] }, { slug: 'locations', fields: [] }],
        secret: 'test',
      } as unknown as Config),
    ).toThrow('locations')
  })

  it('has a generic tree: name, slug, parent, computed depth and legacyId', () => {
    expect(Locations.fields.map((field) => ('name' in field ? field.name : field.type))).toEqual([
      'name',
      'slug',
      'parent',
      'depth',
      'legacyId',
    ])

    expect(fieldNamed(Locations, 'kind')).toBeUndefined()
    expect(fieldNamed(Locations, 'parent')).toMatchObject({ relationTo: 'locations', type: 'relationship' })
    expect(fieldNamed(Locations, 'depth')).toMatchObject({ type: 'number', index: true })
    expect(fieldNamed(Locations, 'legacyId')).toMatchObject({ index: true, type: 'number' })
  })

  it('lets anyone read locations but only tenant staff write them', () => {
    const { access } = Locations

    expect(access?.read?.(requestFor(null))).toBe(true)

    expect(access?.create?.(requestFor(null))).toBe(false)
    expect(access?.create?.(requestFor({ role: 'user', tenants: [] }))).toBe(false)
    expect(
      access?.create?.(requestFor({ role: 'user', tenants: [{ role: 'employer', tenant: 1 }] })),
    ).toBe(false)
    expect(
      access?.create?.(requestFor({ role: 'user', tenants: [{ role: 'editor', tenant: 1 }] })),
    ).toBe(true)
    expect(
      access?.update?.(requestFor({ role: 'user', tenants: [{ role: 'tenant-admin', tenant: 1 }] })),
    ).toBe(true)
    expect(access?.delete?.(requestFor({ role: 'super-admin' }))).toBe(true)
  })

  it('slugifies legacy names into lowercase ASCII slugs', () => {
    expect(slugifyLocationName('Port Vila')).toBe('port-vila')
    expect(slugifyLocationName('Espiritu Santo')).toBe('espiritu-santo')
    expect(slugifyLocationName('Anywhere/Work From Home')).toBe('anywhere-work-from-home')
    expect(slugifyLocationName('Sulphur Bay')).toBe('sulphur-bay')
  })
})

type FieldValidate = (
  value: unknown,
  options: {
    data: Record<string, unknown>
    id?: number | string
    req: ReturnType<typeof validatingReq>
  },
) => Promise<string | true>

const validateOf = (collection: CollectionConfig, name: string): FieldValidate => {
  const field = collection.fields.find((candidate) => 'name' in candidate && candidate.name === name)
  const validate = (field as { validate?: FieldValidate } | undefined)?.validate
  if (!validate) throw new Error(`Missing validate on ${name}`)

  return validate
}

/** A `req` whose `find`/`findByID` return the documents the test passes in. */
const validatingReq = (docs: Record<string, unknown>[] = []) => ({
  payload: {
    find: async () => ({ docs }),
    findByID: async ({ id }: { id: number | string }) =>
      docs.find((doc) => String(doc.id) === String(id)) ?? null,
  },
})

type ChangeHook = (args: unknown) => Promise<unknown>

const changeHook = (collection: CollectionConfig): ChangeHook => {
  const hook = collection.hooks?.beforeChange?.[0]
  if (!hook) throw new Error('Missing beforeChange hook')

  return hook as ChangeHook
}

const run = (collection: CollectionConfig, args: unknown): Promise<Record<string, unknown>> =>
  changeHook(collection)(args) as Promise<Record<string, unknown>>

const errorMessages = async (collection: CollectionConfig, args: unknown): Promise<string[]> => {
  const error = await run(collection, args).then(
    () => null,
    (reason: unknown) => reason as { data?: { errors?: { message: string }[] } },
  )

  return (error?.data?.errors ?? []).map((fieldError) => fieldError.message)
}

const tenantlessCollection = locationsCollection({ requireTenant: true })
const singleTenantCollection = locationsCollection()

describe('locations shared slug rules in single-tenant mode @S-120', () => {
  const collection = locationsCollection({
    slugRules: slugRulesFor({
      jobCategories: 'job-categories',
      jobTypes: 'job-types',
      locations: 'locations',
    }),
  })

  it('applies the reserved words and the shared namespace with no tenant', async () => {
    const validateSlug = validateOf(collection, 'slug')

    expect(await validateSlug('page', { data: {}, id: 1, req: validatingReq() })).toMatch(
      /reserved/,
    )
    expect(
      await validateSlug('hospitality', {
        data: {},
        id: 1,
        req: validatingReq([{ id: 9, slug: 'hospitality' }]),
      }),
    ).toMatch(/already used/)
    expect(await validateSlug('free-slug', { data: {}, id: 1, req: validatingReq() })).toBe(true)
  })
})

describe('locations tenant requirements', () => {
  const scenarios = [
    { label: 'multi-tenant', collection: tenantlessCollection, tenantlessValid: false },
    { label: 'single-tenant', collection: singleTenantCollection, tenantlessValid: true },
  ]

  it.each(scenarios)(
    'checks the slug only against its own tenant in $label mode',
    async ({ collection }) => {
      const validateSlug = validateOf(collection, 'slug')
      const taken = { id: 5, slug: 'port-vila', tenant: 2 }

      expect(
        await validateSlug('port-vila', {
          data: { tenant: 2 },
          id: 6,
          req: validatingReq([taken]),
        }),
      ).toBe('The slug "port-vila" is already used by another location in this tenant')

      // Nothing in tenant 3, so the same slug there is free.
      expect(
        await validateSlug('port-vila', {
          data: { tenant: 3 },
          id: 7,
          req: validatingReq(),
        }),
      ).toBe(true)

      // The same document keeping its slug is not a clash with itself.
      expect(
        await validateSlug('port-vila', {
          data: { tenant: 2 },
          id: 5,
          req: validatingReq([taken]),
        }),
      ).toBe(true)
    },
  )

  it.each(scenarios)(
    'rejects a tenantless write in $label mode only when a tenant is required',
    async ({ collection, tenantlessValid }) => {
      if (tenantlessValid) {
        await expect(run(collection, { data: { name: 'Port Vila' }, operation: 'create' })).resolves.toEqual({
          depth: 0,
          name: 'Port Vila',
        })
        return
      }

      await expect(
        errorMessages(collection, { data: { name: 'Port Vila' }, operation: 'create' }),
      ).resolves.toEqual(['A location must belong to a tenant'])
      // An update that clears the tenant is refused, and one that keeps the stored tenant passes
      // even though the request does not carry it.
      await expect(
        errorMessages(collection, { data: { name: 'Port Vila', tenant: null }, operation: 'update' }),
      ).resolves.toEqual(['A location must belong to a tenant'])
      await expect(
        run(collection, {
          data: { name: 'Port Vila' },
          operation: 'update',
          originalDoc: { tenant: 2 },
        }),
      ).resolves.toEqual({ depth: 0, name: 'Port Vila' })
    },
  )
})

describe('locations tree', () => {
  it('computes depth from the whole parent chain, not from a fixed kind', async () => {
    const docs = [
      { id: 1, parent: null, tenant: 2 },
      { id: 7, parent: 1, tenant: 2 },
      { id: 8, parent: 7, tenant: 2 },
    ]

    await expect(
      run(tenantlessCollection, {
        data: { name: 'Efate', tenant: 2 },
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toMatchObject({ depth: 0 })

    await expect(
      run(tenantlessCollection, {
        data: { name: 'Port Vila', parent: 1, tenant: 2 },
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toMatchObject({ depth: 1 })

    await expect(
      run(tenantlessCollection, {
        data: { name: 'Sulphur Bay', parent: 7, tenant: 2 },
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toMatchObject({ depth: 2 })
  })

  it('caps depth per tenant and names the levels in the error', async () => {
    const docs = [
      { id: 1, parent: null, tenant: 2 },
      { id: 7, parent: 1, tenant: 2 },
    ]

    // Tenant 2 names Island → Town and allows two levels; tenant 3 names three levels.
    await expect(
      run(limitedCollection, {
        data: { name: 'Port Vila', parent: 1, tenant: 2 },
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toMatchObject({ depth: 1 })

    await expect(
      errorMessages(limitedCollection, {
        data: { name: 'Sulphur Bay', parent: 7, tenant: 2 },
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toEqual(['This tenant allows at most 2 location levels (Island → Town)'])

    await expect(
      run(limitedCollection, {
        data: { name: 'Sulphur Bay', parent: 7, tenant: 3 },
        operation: 'create',
        req: validatingReq([{ id: 1, parent: null, tenant: 3 }, { id: 7, parent: 1, tenant: 3 }]),
      }),
    ).resolves.toMatchObject({ depth: 2 })
  })

  it('refuses to put a location under itself or one of its descendants', async () => {
    const docs = [
      { id: 1, parent: null, tenant: 2 },
      { id: 7, parent: 1, tenant: 2 },
    ]

    await expect(
      errorMessages(tenantlessCollection, {
        data: { parent: 1, tenant: 2 },
        id: 1,
        operation: 'update',
        originalDoc: { id: 1, tenant: 2 },
        req: validatingReq(docs),
      }),
    ).resolves.toEqual(['A location cannot be its own parent'])

    await expect(
      errorMessages(tenantlessCollection, {
        data: { parent: 7, tenant: 2 },
        id: 1,
        operation: 'update',
        originalDoc: { id: 1, tenant: 2 },
        req: validatingReq(docs),
      }),
    ).resolves.toEqual(['A location cannot sit under one of its own descendants'])
  })

  it('refuses a stored parent chain that already loops', async () => {
    const docs = [
      { id: 1, parent: 7, tenant: 2 },
      { id: 7, parent: 1, tenant: 2 },
    ]

    await expect(
      errorMessages(tenantlessCollection, {
        data: { parent: 7, tenant: 2 },
        id: 9,
        operation: 'create',
        req: validatingReq(docs),
      }),
    ).resolves.toEqual(['The location tree loops; fix the parents before saving'])
  })

  it.each([
    { label: 'multi-tenant', collection: tenantlessCollection },
    { label: 'single-tenant', collection: singleTenantCollection },
  ])('only accepts a parent from the same tenant in $label mode', async ({ collection }) => {
    const validateParent = validateOf(collection, 'parent')
    const parent = { id: 7, parent: null, tenant: 2 }

    expect(
      await validateParent(
        { id: 7 },
        { data: { tenant: 2 }, id: 8, req: validatingReq([parent]) },
      ),
    ).toBe(true)

    expect(
      await validateParent(
        { id: 7 },
        { data: { tenant: 3 }, id: 9, req: validatingReq([parent]) },
      ),
    ).toBe('The parent location belongs to another tenant')

    // A parent with no tenant cannot be in the same tenant as a child that has one.
    expect(
      await validateParent(
        { id: 7 },
        { data: { tenant: 2 }, id: 10, req: validatingReq([{ ...parent, tenant: null }]) },
      ),
    ).toBe('The parent location belongs to no tenant')

    // A tenantless child never reaches a comparison: the beforeChange hook refuses it in
    // multi-tenant mode, and in single mode there is no tenant field to compare.
    expect(
      await validateParent({ id: 7 }, { data: {}, id: 11, req: validatingReq([parent]) }),
    ).toBe(true)
    expect(
      await validateParent(
        { id: 7 },
        { data: {}, id: 12, req: validatingReq([{ ...parent, tenant: null }]) },
      ),
    ).toBe(true)
  })
})
