import type { AccessArgs, CollectionConfig, Field, TextField } from 'payload'
import { describe, expect, it } from 'vitest'

import type { MissionControlUser } from '../access'
import {
  ORGANISATION_ADMIN_ROLES,
  ORGANISATION_EDITOR_ROLES,
  organisationTenantIsStable,
  ORGANISATION_SIZES,
  ORGANISATION_TYPES,
  PUBLIC_ORGANISATION_FILTER,
  organisationAdminFieldAccess,
  organisationsCollection,
  organisationTypeOptions,
  validateUrl,
} from './organisations'
import { hashSiteKey } from '../site-keys'

const collection: CollectionConfig = organisationsCollection()

const fieldNamed = (name: string, source: CollectionConfig = collection): Field => {
  const find = (fields: Field[]): Field | undefined => {
    for (const field of fields) {
      if ('name' in field && field.name === name) return field
      if ('fields' in field && Array.isArray(field.fields)) {
        const found = find(field.fields)
        if (found) return found
      }
    }
    return undefined
  }

  const field = find(source.fields)
  if (!field) throw new Error(`Missing field ${name}`)
  return field
}

const userWith = (
  tenants: { role: 'editor' | 'employer' | 'seeker' | 'tenant-admin'; tenant: number }[],
  extra: Partial<MissionControlUser> = {},
): MissionControlUser => ({ id: 1, role: 'user', tenants, ...extra })

const argsFor = (user: MissionControlUser | null, data?: Record<string, unknown>) =>
  ({ data, req: { user } }) as unknown as AccessArgs

const adminOf = (...tenants: number[]): MissionControlUser =>
  userWith(tenants.map((tenant) => ({ role: 'tenant-admin' as const, tenant })))

const fieldArgsFor = (user: MissionControlUser | null) =>
  ({ req: { user } }) as unknown as Parameters<typeof organisationAdminFieldAccess>[0]

/** An anonymous request with a site key, resolved against a stub `site-keys` collection. */
const siteKeyRequest = async ({
  isAggregate = false,
  key,
  known = true,
  tenant,
}: {
  isAggregate?: boolean
  key: string
  known?: boolean
  tenant: number
}) => {
  const keyHash = await hashSiteKey(key)

  return {
    context: {},
    headers: new Headers({ 'x-site-key': key }),
    payload: {
      collections: { 'site-keys': {} },
      find: async (args: { where?: { keyHash?: { equals?: string } } }) => ({
        docs:
          known && args.where?.keyHash?.equals === keyHash
            ? [{ id: 1, tenant: { id: tenant, isAggregate } }]
            : [],
      }),
    },
    user: null,
  } as never
}

const readWith = (req: unknown) => {
  const read = collection.access?.read
  if (!read) throw new Error('Missing read access')
  return read({ req, slug: 'organisations' } as never)
}

describe('organisations collection config', () => {
  it('covers every field the task names', () => {
    for (const name of [
      'name',
      'slug',
      'type',
      'size',
      'areasOfFocus',
      'logo',
      'cover',
      'website',
      'phone',
      'location',
      'about',
      'pageEnabled',
      'listingRequested',
      'canPayByInvoice',
      'billingEmail',
      'xeroContactCode',
      'approved',
      'legacyId',
    ]) {
      expect(() => fieldNamed(name), name).not.toThrow()
    }

    const socials = fieldNamed('socials') as { fields: Field[] }
    expect(socials.fields.map((field) => ('name' in field ? field.name : ''))).toEqual([
      'facebook',
      'instagram',
      'linkedin',
      'x',
      'youtube',
    ])
  })

  it('offers the legacy organisation types and size bands', () => {
    expect(fieldNamed('type')).toMatchObject({ type: 'select', options: organisationTypeOptions })
    expect(ORGANISATION_TYPES).toEqual([
      'business',
      'government',
      'nfp',
      'consultant',
      'recruiter',
      'social-enterprise',
    ])
    expect(fieldNamed('size')).toMatchObject({ type: 'select' })
    expect(ORGANISATION_SIZES).toHaveLength(5)
  })

  it('relates the profile to the tenant taxonomies, locations and media', () => {
    expect(fieldNamed('areasOfFocus')).toMatchObject({
      hasMany: true,
      relationTo: 'areas-of-focus',
      type: 'relationship',
    })
    expect(fieldNamed('location')).toMatchObject({
      relationTo: 'locations',
      type: 'relationship',
    })
    expect(fieldNamed('logo')).toMatchObject({ relationTo: 'media', type: 'upload' })
    expect(fieldNamed('cover')).toMatchObject({ relationTo: 'media', type: 'upload' })
  })

  it('indexes the slug and the legacy id, and keeps the slug unique per tenant', () => {
    expect(fieldNamed('slug')).toMatchObject({ index: true, required: true })
    expect(fieldNamed('legacyId')).toMatchObject({ index: true, type: 'number' })
    expect(collection.indexes).toEqual([{ fields: ['tenant', 'slug'], unique: true }])
    expect(collection.versions).toBe(false)
  })

  it('drops the media fields and the compound index without a media collection', () => {
    const single = organisationsCollection({ mediaSlug: null, tenantScoped: false })

    expect(single.indexes).toEqual([])
    expect(single.fields.some((field) => 'name' in field && field.name === 'logo')).toBe(false)
    expect(() => fieldNamed('logo', single)).toThrow()
  })

  it('leaves the images out when the host has no upload collection', async () => {
    const { payloadJobs } = await import('../index')
    const config = await payloadJobs()({
      collections: [{ slug: 'users', fields: [] }],
      secret: 'test',
    } as never)

    const organisations = config.collections?.find((c) => c.slug === 'organisations')
    if (!organisations) throw new Error('Missing organisations')

    expect(() => fieldNamed('logo', organisations)).toThrow()
    expect(() => fieldNamed('name', organisations)).not.toThrow()
  })
})

describe('organisation slug and URL validation', () => {
  const slug = fieldNamed('slug') as TextField & { validate: (value: unknown) => unknown }

  it('accepts lowercase slugs and rejects anything else', () => {
    expect(slug.validate('vanuatu-brewing')).toBe(true)
    expect(slug.validate('acme')).toBe(true)
    expect(slug.validate('Acme Ltd')).toMatch(/lowercase/)
    expect(slug.validate('acme_ltd')).toMatch(/lowercase/)
    expect(slug.validate('')).toMatch(/lowercase/)
  })

  it('accepts a full web address and rejects a bare domain', () => {
    expect(validateUrl('https://www.example.com/about')).toBe(true)
    expect(validateUrl('http://example.com')).toBe(true)
    expect(validateUrl('')).toBe(true)
    expect(validateUrl(undefined)).toBe(true)
    expect(validateUrl('example.com')).toMatch(/http/)
    expect(validateUrl('javascript:alert(1)')).toMatch(/http/)
    expect(validateUrl('ftp://example.com')).toMatch(/http/)
  })
})

describe('organisation field access', () => {
  it('reserves approval, the page toggle, billing and the legacy id for tenant admins', () => {
    for (const name of [
      'approved',
      'pageEnabled',
      'canPayByInvoice',
      'billingEmail',
      'xeroContactCode',
      'legacyId',
    ]) {
      const field = fieldNamed(name) as { access?: { update?: unknown; create?: unknown } }
      expect(field.access?.update, name).toBe(organisationAdminFieldAccess)
      expect(field.access?.create, name).toBe(organisationAdminFieldAccess)
    }
  })

  it('leaves the profile fields editable by the employer', () => {
    for (const name of ['name', 'slug', 'about', 'website', 'phone', 'size', 'type']) {
      const field = fieldNamed(name) as { access?: unknown }
      expect(field.access, name).toBeUndefined()
    }
    // The listing request is the employer's own action.
    expect(fieldNamed('listingRequested')).toMatchObject({ defaultValue: false })
  })

  it('lets tenant admins and super admins set the admin-only fields but nobody else', () => {
    expect(organisationAdminFieldAccess(fieldArgsFor(userWith([{ role: 'tenant-admin', tenant: 1 }])))).toBe(true)
    expect(organisationAdminFieldAccess(fieldArgsFor(userWith([], { role: 'super-admin' })))).toBe(true)
    expect(organisationAdminFieldAccess(fieldArgsFor(userWith([{ role: 'editor', tenant: 1 }])))).toBe(false)
    expect(organisationAdminFieldAccess(fieldArgsFor(userWith([{ role: 'employer', tenant: 1 }], { organisation: 5 })))).toBe(false)
    expect(organisationAdminFieldAccess(fieldArgsFor(null))).toBe(false)
  })

  it('uses tenant-admin for the admin-only fields and includes editors in the staff roles', () => {
    expect([...ORGANISATION_ADMIN_ROLES]).toEqual(['tenant-admin'])
    expect([...ORGANISATION_EDITOR_ROLES]).toEqual(['tenant-admin', 'editor'])
  })
})

describe('organisation read access', () => {
  const read = collection.access?.read
  if (!read) throw new Error('Missing read access')

  it('gives staff every organisation in their own tenants', async () => {
    expect(await read(argsFor(userWith([{ role: 'tenant-admin', tenant: 10 }])))).toEqual({
      tenant: { in: [10] },
    })
    expect(await read(argsFor(userWith([{ role: 'editor', tenant: 20 }])))).toEqual({
      tenant: { in: [20] },
    })
  })

  it('gives an employer only their own organisation', async () => {
    const employer = userWith([{ role: 'employer', tenant: 10 }], { organisation: 7 })

    expect(await read(argsFor(employer))).toEqual({ id: { equals: 7 } })
  })

  it('lets staff who also run an organisation see both sets', async () => {
    const owner = userWith([{ role: 'tenant-admin', tenant: 10 }], { organisation: 7 })

    expect(await read(argsFor(owner))).toEqual({
      or: [{ tenant: { in: [10] } }, { id: { equals: 7 } }],
    })
  })

  it('denies seekers, users with no membership, and anonymous callers', async () => {
    expect(await read(argsFor(userWith([{ role: 'seeker', tenant: 10 }], { organisation: 7 })))).toBe(
      false,
    )
    expect(await read(argsFor(userWith([])))).toBe(false)
    expect(await read(argsFor(null))).toBe(false)
  })

  it('lets a super-admin read every organisation', async () => {
    expect(await read(argsFor(userWith([], { role: 'super-admin' })))).toBe(true)
  })

  it('shows a site key only approved organisations with a live page', async () => {
    const req = await siteKeyRequest({ key: 'sk_tenant', tenant: 10 })

    expect(await readWith(req)).toEqual({
      and: [{ tenant: { equals: 10 } }, PUBLIC_ORGANISATION_FILTER],
    })
    expect(await readWith(await siteKeyRequest({ isAggregate: true, key: 'sk_hub', tenant: 1 }))).toEqual(
      PUBLIC_ORGANISATION_FILTER,
    )
  })

  it('rejects an unknown site key', async () => {
    expect(await readWith(await siteKeyRequest({ key: 'sk_nope', known: false, tenant: 10 }))).toBe(
      false,
    )
  })

  it('keeps anonymous reads closed without a site key header', async () => {
    expect(await readWith({ headers: new Headers(), payload: {}, user: null })).toBe(false)
  })
})

describe('single-tenant mode', () => {
  const single = organisationsCollection({ tenantScoped: false })
  const read = single.access?.read
  const update = single.access?.update
  const create = single.access?.create
  const remove = single.access?.delete
  if (!read || !update || !create || !remove) throw new Error('Missing access')

  it('gives staff every organisation and an employer their own', async () => {
    expect(await read(argsFor(userWith([{ role: 'editor', tenant: 1 }])))).toBe(true)
    expect(await read(argsFor(userWith([{ role: 'employer', tenant: 1 }], { organisation: 7 })))).toEqual(
      { id: { equals: 7 } },
    )
    expect(await read(argsFor(userWith([{ role: 'employer', tenant: 1 }])))).toBe(false)
    expect(await read(argsFor(null))).toBe(false)
  })

  it('takes no tenant in create data and scopes updates and deletes by role', async () => {
    expect(await create(argsFor(userWith([{ role: 'tenant-admin', tenant: 1 }]), { name: 'Acme' }))).toBe(
      true,
    )
    expect(await create(argsFor(userWith([{ role: 'employer', tenant: 1 }])))).toBe(false)
    expect(await update(argsFor(userWith([{ role: 'editor', tenant: 1 }])))).toBe(true)
    expect(await update(argsFor(userWith([{ role: 'employer', tenant: 1 }], { organisation: 7 })))).toEqual(
      { id: { equals: 7 } },
    )
    expect(await remove(argsFor(userWith([{ role: 'tenant-admin', tenant: 1 }])))).toBe(true)
    expect(await remove(argsFor(userWith([{ role: 'editor', tenant: 1 }])))).toBe(false)
  })
})

describe('organisation write access', () => {
  const create = collection.access?.create
  const update = collection.access?.update
  const remove = collection.access?.delete
  if (!create || !update || !remove) throw new Error('Missing write access')

  it('lets staff create only inside their own tenants', async () => {
    const admin = userWith([{ role: 'tenant-admin', tenant: 10 }])

    expect(await create(argsFor(admin, { name: 'Acme', tenant: 10 }))).toBe(true)
    expect(await create(argsFor(admin, { name: 'Acme', tenant: 20 }))).toBe(false)
    // A create without a tenant would sit outside every tenant.
    expect(await create(argsFor(admin, { name: 'Acme' }))).toBe(false)
    expect(await create(argsFor(userWith([], { role: 'super-admin' }), { tenant: 10 }))).toBe(true)
  })

  it('keeps employers out of creating organisations', async () => {
    const employer = userWith([{ role: 'employer', tenant: 10 }])

    expect(await create(argsFor(employer, { name: 'Acme', tenant: 10 }))).toBe(false)
  })

  it('lets an employer update their own organisation and nobody else’s', async () => {
    const employer = userWith([{ role: 'employer', tenant: 10 }], { organisation: 7 })

    expect(await update(argsFor(employer))).toEqual({ id: { equals: 7 } })
  })

  it('scopes staff updates to their tenants', async () => {
    expect(await update(argsFor(userWith([{ role: 'editor', tenant: 10 }])))).toEqual({
      tenant: { in: [10] },
    })
    expect(await update(argsFor(userWith([], { role: 'super-admin' })))).toBe(true)
    expect(await update(argsFor(userWith([{ role: 'seeker', tenant: 10 }])))).toBe(false)
    expect(await update(argsFor(null))).toBe(false)
  })

  it('reserves deletes for tenant admins', async () => {
    expect(await remove(argsFor(userWith([{ role: 'tenant-admin', tenant: 10 }])))).toEqual({
      tenant: { in: [10] },
    })
    expect(await remove(argsFor(userWith([{ role: 'editor', tenant: 10 }])))).toBe(false)
    expect(
      await remove(argsFor(userWith([{ role: 'employer', tenant: 10 }], { organisation: 7 }))),
    ).toBe(false)
    expect(await remove(argsFor(userWith([], { role: 'super-admin' })))).toBe(true)
  })
})

describe('organisationTenantIsStable', () => {
  const moveHook = organisationTenantIsStable(true)
  const move = (user: MissionControlUser | null, data: Record<string, unknown> = { tenant: 2 }) =>
    moveHook({
      data,
      operation: 'update',
      originalDoc: { tenant: 1 },
      req: { user },
    } as never)
  // The hook throws synchronously, so a plain try/catch reads better than `rejects`.
  const rejectsMove = (user: MissionControlUser): void => {
    try {
      move(user)
    } catch (thrown) {
      expect(JSON.stringify(thrown)).toMatch(/Only a tenant admin of both tenants/)
      return
    }
    throw new Error('Expected the move to be rejected')
  }

  it('needs admin rights in both the tenant it leaves and the one it joins', async () => {
    rejectsMove(adminOf(1))
    rejectsMove(adminOf(2))

    // The review case: an admin of an unrelated tenant, an employer in both affected ones.
    rejectsMove(
      userWith([
        { role: 'employer', tenant: 1 },
        { role: 'tenant-admin', tenant: 3 },
      ]),
    )

    expect(await move(adminOf(1, 2))).toEqual({ tenant: 2 })
  })

  it('lets a super admin and a system write through', async () => {
    expect(await move(userWith([], { role: 'super-admin' }))).toEqual({ tenant: 2 })
    expect(await move(null)).toEqual({ tenant: 2 })
  })

  it('ignores writes that keep the tenant, omit it, or run unscoped', async () => {
    expect(await move(userWith([{ role: 'employer', tenant: 1 }]), { tenant: 1 })).toEqual({
      tenant: 1,
    })
    expect(await move(userWith([{ role: 'employer', tenant: 1 }]), { name: 'Renamed' })).toEqual({
      name: 'Renamed',
    })
    expect(
      await organisationTenantIsStable(false)({
        data: { tenant: 2 },
        operation: 'update',
        originalDoc: { tenant: 1 },
        req: { user: userWith([{ role: 'employer', tenant: 1 }]) },
      } as never),
    ).toEqual({ tenant: 2 })
  })
})
