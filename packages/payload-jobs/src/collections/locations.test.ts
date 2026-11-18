import type { CollectionConfig, Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from '../index'
import { TAXONOMY_SLUGS } from '../taxonomies'
import {
  ALLOWED_PARENT_KINDS,
  LOCATION_KINDS,
  locationsCollection,
  slugifyLocationName,
} from './locations'

const baseConfig = {
  collections: [{ slug: 'users', fields: [] }],
  secret: 'test',
} as unknown as Config

const Locations = locationsCollection()

const fieldNamed = (name: string) =>
  Locations.fields.find((field) => 'name' in field && field.name === name)

const requestFor = (user: unknown) => ({ req: { user } }) as never

describe('locations collection', () => {
  it('is registered by the plugin without touching the host collections', async () => {
    const config = await payloadJobs()(baseConfig)

    expect(config.collections?.map((collection) => collection.slug)).toEqual([
      'users',
      'locations',
      'organisations',
      ...TAXONOMY_SLUGS,
      'plans',
      'add-ons',
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

  it('has the tree fields the task asks for, plus legacyId for the importer', () => {
    expect(Locations.fields.map((field) => ('name' in field ? field.name : field.type))).toEqual([
      'name',
      'slug',
      'kind',
      'parent',
      'legacyId',
    ])

    expect(fieldNamed('kind')).toMatchObject({ type: 'select', required: true })
    expect(fieldNamed('parent')).toMatchObject({ relationTo: 'locations', type: 'relationship' })
    expect(fieldNamed('legacyId')).toMatchObject({ index: true, type: 'number' })
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

  it('orders kinds strictly so a parent cycle is impossible', () => {
    expect([...LOCATION_KINDS]).toEqual(['region', 'island', 'town'])
    expect(ALLOWED_PARENT_KINDS.region).toEqual([])
    expect(ALLOWED_PARENT_KINDS.island).toEqual(['region'])
    expect(ALLOWED_PARENT_KINDS.town).toEqual(['region', 'island'])
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

const tenantlessCollection = locationsCollection({ requireTenant: true })
const singleTenantCollection = locationsCollection()

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
          data: { kind: 'region', tenant: 2 },
          id: 6,
          req: validatingReq([taken]),
        }),
      ).toBe('The slug "port-vila" is already used by another location in this tenant')

      // Nothing in tenant 3, so the same slug there is free.
      expect(
        await validateSlug('port-vila', {
          data: { kind: 'region', tenant: 3 },
          id: 7,
          req: validatingReq(),
        }),
      ).toBe(true)

      // The same document keeping its slug is not a clash with itself.
      expect(
        await validateSlug('port-vila', {
          data: { kind: 'region', tenant: 2 },
          id: 5,
          req: validatingReq([taken]),
        }),
      ).toBe(true)
    },
  )

  it.each(scenarios)(
    'rejects a tenantless write in $label mode only when a tenant is required',
    async ({ collection, tenantlessValid }) => {
      const hook = collection.hooks?.beforeChange?.[0] as
        | ((args: unknown) => Promise<unknown>)
        | undefined
      const run = (args: unknown) =>
        hook ? Promise.resolve().then(() => hook(args)) : Promise.resolve((args as { data: unknown }).data)

      const tenantError = async (args: unknown) => {
        const error = await run(args).then(
          () => null,
          (reason: unknown) => reason as { data?: { errors?: { message: string }[] } },
        )

        return error?.data?.errors?.map((fieldError) => fieldError.message)
      }

      if (tenantlessValid) {
        expect(hook).toBeUndefined()
        await expect(run({ data: { name: 'Port Vila' }, operation: 'create' })).resolves.toEqual({
          name: 'Port Vila',
        })
        return
      }

      await expect(tenantError({ data: { name: 'Port Vila' }, operation: 'create' })).resolves.toEqual(
        ['A location must belong to a tenant'],
      )
      // An update that clears the tenant is refused, and one that keeps the stored tenant passes
      // even though the request does not carry it.
      await expect(
        tenantError({ data: { name: 'Port Vila', tenant: null }, operation: 'update' }),
      ).resolves.toEqual(['A location must belong to a tenant'])
      await expect(
        run({ data: { name: 'Port Vila' }, operation: 'update', originalDoc: { tenant: 2 } }),
      ).resolves.toEqual({ name: 'Port Vila' })
    },
  )

  it('rechecks the tree on an update that does not submit the parent field', async () => {
    const hook = tenantlessCollection.hooks?.beforeChange?.[0] as (
      args: unknown,
    ) => Promise<unknown>

    const messageFor = async (args: unknown) => {
      const error = await Promise.resolve()
        .then(() => hook(args))
        .then(
          () => null,
          (reason: unknown) =>
            reason as { data?: { errors?: { message: string }[] } },
        )

      return error?.data?.errors?.map((fieldError) => fieldError.message)
    }

    // `kind` alone moves from island to region: the stored parent would then be invalid, so the
    // hook must refuse it even though the request never mentions `parent`.
    await expect(
      messageFor({
        data: { kind: 'region' },
        id: 10,
        operation: 'update',
        originalDoc: { kind: 'island', parent: 3, tenant: 2 },
        req: validatingReq(),
      }),
    ).resolves.toEqual(['A region cannot have a parent'])

    // Clearing the parent in the same write is fine.
    await expect(
      Promise.resolve()
        .then(() =>
          hook({
            data: { kind: 'region', parent: null },
            id: 10,
            operation: 'update',
            originalDoc: { kind: 'island', parent: 3, tenant: 2 },
            req: validatingReq(),
          }),
        )
        .then((result) => result as unknown),
    ).resolves.toEqual({ kind: 'region', parent: null })
  })

  it.each(scenarios)(
    'only accepts a parent from the same tenant in $label mode',
    async ({ collection }) => {
      const validateParent = validateOf(collection, 'parent')
      const parent = { id: 7, kind: 'region', tenant: 2 }

      expect(
        await validateParent(
          { id: 7 },
          { data: { kind: 'island', tenant: 2 }, id: 8, req: validatingReq([parent]) },
        ),
      ).toBe(true)

      expect(
        await validateParent(
          { id: 7 },
          { data: { kind: 'island', tenant: 3 }, id: 9, req: validatingReq([parent]) },
        ),
      ).toBe('The parent location belongs to another tenant')

      // A parent with no tenant cannot be in the same tenant as a child that has one.
      expect(
        await validateParent(
          { id: 7 },
          {
            data: { kind: 'island', tenant: 2 },
            id: 10,
            req: validatingReq([{ ...parent, tenant: null }]),
          },
        ),
      ).toBe('The parent location belongs to no tenant')

      // A tenantless child never reaches a comparison: the beforeChange hook refuses it in
      // multi-tenant mode, and in single mode there is no tenant field to compare.
      expect(
        await validateParent(
          { id: 7 },
          { data: { kind: 'island' }, id: 11, req: validatingReq([parent]) },
        ),
      ).toBe(true)
      expect(
        await validateParent(
          { id: 7 },
          { data: { kind: 'island' }, id: 12, req: validatingReq([{ ...parent, tenant: null }]) },
        ),
      ).toBe(true)
    },
  )
})
