import type { CollectionConfig } from 'payload'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MissionControlUser } from '../access'
import { taxonomyCollections } from '../taxonomies'
import { locationsCollection } from './locations'
import { organisationField, organisationsCollection } from './organisations'
import { bootTestPayload, tenantIsolation, type TestHarness } from '../test'

/**
 * `mediaSlug: null` keeps the boot free of an upload collection: the images are checked in the
 * config tests, and everything else here needs only relations to tenant-owned documents.
 */
const organisations = (): CollectionConfig[] => [
  organisationsCollection({ mediaSlug: null }),
  locationsCollection({ requireTenant: true }),
  ...taxonomyCollections({ tenantScoped: true }),
]

const organisationData = (overrides: Record<string, unknown> = {}) => ({
  about: 'We brew beer in Port Vila.',
  name: 'Vanuatu Brewing',
  slug: `brewing-${Math.random().toString(36).slice(2, 8)}`,
  ...overrides,
})

tenantIsolation({
  boot: { userFields: [organisationField()] },
  collection: organisationsCollection({ mediaSlug: null }),
  createData: (tenant) => organisationData({ slug: `brewing-${tenant.id}` }),
  extraCollections: organisations().slice(1),
})

type Employer = MissionControlUser & {
  collection: 'users'
  email: string
  id: number
  role: 'user'
}

describe('organisations integration', () => {
  let harness: TestHarness
  let orgA: { id: number }
  let orgB: { id: number }
  let employer: Employer
  let employerEmail: null | string = null
  let createdUserIDs: number[] = []

  const makeUser = async (
    label: string,
    tenants: Employer['tenants'],
    extra: Record<string, unknown> = {},
  ): Promise<Employer> => {
    const doc = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants,
        ...extra,
      },
      overrideAccess: true,
    })) as { email: string; id: number }
    createdUserIDs.push(doc.id)

    return {
      collection: 'users',
      email: doc.email,
      id: doc.id,
      role: 'user',
      tenants,
      ...extra,
    } as Employer
  }

  beforeEach(async () => {
    createdUserIDs = []
    employerEmail = null
    harness = await bootTestPayload({
      collections: organisations(),
      userFields: [organisationField()],
    })

    orgA = (await harness.payload.create({
      collection: 'organisations',
      data: { ...organisationData({ slug: 'brewing-a' }), tenant: harness.tenantA.id } as never,
      overrideAccess: true,
    })) as { id: number }

    orgB = (await harness.payload.create({
      collection: 'organisations',
      data: { ...organisationData({ slug: 'brewing-b' }), tenant: harness.tenantB.id } as never,
      overrideAccess: true,
    })) as { id: number }

    employer = await makeUser(
      'employer',
      [{ role: 'employer', tenant: harness.tenantA.id }],
      { organisation: orgA.id },
    )
    employerEmail = employer.email
  })

  afterEach(async () => {
    if (!harness) return

    if (createdUserIDs.length > 0) {
      await harness.payload.delete({
        collection: 'users',
        overrideAccess: true,
        where: { id: { in: createdUserIDs } },
      })
    }

    await harness.destroy()
  })

  const stored = async (id: number) =>
    (await harness.payload.findByID({
      collection: 'organisations',
      depth: 0,
      id,
      overrideAccess: true,
    })) as Record<string, unknown>

  it('keeps one slug per tenant and the same slug on two tenants', async () => {
    await expect(
      harness.payload.create({
        collection: 'organisations',
        data: { ...organisationData({ slug: 'brewing-a' }), tenant: harness.tenantA.id } as never,
        overrideAccess: true,
      }),
    ).rejects.toThrow()

    await expect(
      harness.payload.create({
        collection: 'organisations',
        data: { ...organisationData({ slug: 'brewing-a' }), tenant: harness.tenantB.id } as never,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ slug: 'brewing-a' })
  })

  it('keeps the WordPress user id for the import', async () => {
    const imported = await harness.payload.create({
      collection: 'organisations',
      data: {
        ...organisationData({ legacyId: 4711, slug: 'imported' }),
        tenant: harness.tenantA.id,
      } as never,
      overrideAccess: true,
    })

    expect(imported).toMatchObject({ legacyId: 4711 })
  })

  it('lets an employer read their own organisation only', async () => {
    const { docs } = await harness.payload.find({
      collection: 'organisations',
      user: employer as never,
    })

    expect(docs.map((doc) => doc.id)).toEqual([orgA.id])
  })

  it('lets an employer edit the profile but drops the admin-only fields', async () => {
    await harness.payload.update({
      collection: 'organisations',
      data: {
        approved: true,
        billingEmail: 'pay@example.invalid',
        canPayByInvoice: true,
        name: 'Vanuatu Brewing Ltd',
        pageEnabled: true,
        website: 'https://example.vu',
        xeroContactCode: 'XERO-1',
      } as never,
      id: orgA.id,
      user: employer as never,
    })

    const doc = await stored(orgA.id)

    expect(doc).toMatchObject({
      approved: false,
      canPayByInvoice: false,
      name: 'Vanuatu Brewing Ltd',
      pageEnabled: false,
      website: 'https://example.vu',
    })
    expect(doc.billingEmail ?? null).toBeNull()
    expect(doc.xeroContactCode ?? null).toBeNull()
  })

  it('lets a tenant admin approve an organisation and set its billing terms', async () => {
    const admin = await makeUser('admin-a', [
      { role: 'tenant-admin', tenant: harness.tenantA.id },
    ])

    await harness.payload.update({
      collection: 'organisations',
      data: {
        approved: true,
        billingEmail: 'pay@example.invalid',
        canPayByInvoice: true,
        pageEnabled: true,
        xeroContactCode: 'XERO-1',
      } as never,
      id: orgA.id,
      user: admin as never,
    })

    expect(await stored(orgA.id)).toMatchObject({
      approved: true,
      billingEmail: 'pay@example.invalid',
      canPayByInvoice: true,
      pageEnabled: true,
      xeroContactCode: 'XERO-1',
    })
  })

  it('keeps an employer out of admin-only fields when they administer another tenant', async () => {
    const employerAdminElsewhere = await makeUser(
      'employer-admin-elsewhere',
      [
        { role: 'employer', tenant: harness.tenantA.id },
        { role: 'tenant-admin', tenant: harness.tenantB.id },
      ],
      { organisation: orgA.id },
    )

    await harness.payload.update({
      collection: 'organisations',
      data: {
        approved: true,
        canPayByInvoice: true,
        name: 'Renamed by the employer',
        pageEnabled: true,
      } as never,
      id: orgA.id,
      user: employerAdminElsewhere as never,
    })

    expect(await stored(orgA.id)).toMatchObject({
      approved: false,
      canPayByInvoice: false,
      name: 'Renamed by the employer',
      pageEnabled: false,
    })
  })

  it('hides billing terms and the legacy id from an employer read', async () => {
    await harness.payload.update({
      collection: 'organisations',
      data: {
        approved: true,
        billingEmail: 'pay@example.invalid',
        canPayByInvoice: true,
        legacyId: 4711,
        pageEnabled: true,
        xeroContactCode: 'XERO-1',
      } as never,
      id: orgA.id,
      overrideAccess: true,
    })

    const own = (await harness.payload.findByID({
      collection: 'organisations',
      depth: 0,
      id: orgA.id,
      user: employer as never,
    })) as Record<string, unknown>

    // The employer still sees their own page status and approval.
    expect(own).toMatchObject({ approved: true, id: orgA.id, pageEnabled: true })
    expect(own.billingEmail ?? null).toBeNull()
    expect(own.canPayByInvoice ?? null).toBeNull()
    expect(own.legacyId ?? null).toBeNull()
    expect(own.xeroContactCode ?? null).toBeNull()

    // Staff read everything.
    const asStaff = (await harness.payload.findByID({
      collection: 'organisations',
      depth: 0,
      id: orgA.id,
      user: harness.tenantAdminA as never,
    })) as Record<string, unknown>

    expect(asStaff).toMatchObject({
      billingEmail: 'pay@example.invalid',
      canPayByInvoice: true,
      legacyId: 4711,
      xeroContactCode: 'XERO-1',
    })
  })

  it('rejects an employer editing another organisation', async () => {
    await expect(
      harness.payload.update({
        collection: 'organisations',
        data: { name: 'Hijacked' } as never,
        id: orgB.id,
        user: employer as never,
      }),
    ).rejects.toThrow()

    expect((await stored(orgB.id)).name).toBe('Vanuatu Brewing')
  })

  it('rejects an employer re-pointing their user at another organisation', async () => {
    await harness.payload.update({
      collection: 'users',
      data: { organisation: orgB.id } as never,
      id: employer.id,
      user: employer as never,
    })

    const user = (await harness.payload.findByID({
      collection: 'users',
      depth: 0,
      id: employer.id,
      overrideAccess: true,
    })) as { organisation?: unknown }

    const id = typeof user.organisation === 'object' && user.organisation !== null
      ? (user.organisation as { id: number }).id
      : user.organisation

    expect(id).toBe(orgA.id)
  })

  it('refuses to link a user to an organisation from a tenant they do not belong to', async () => {
    const adminA = await makeUser('admin-a-link', [
      { role: 'tenant-admin', tenant: harness.tenantA.id },
    ])

    await expect(
      harness.payload.update({
        collection: 'users',
        data: { organisation: orgB.id } as never,
        id: employer.id,
        user: adminA as never,
      }),
    ).rejects.toThrow(/Organisation/)

    // Same tenant is fine.
    await expect(
      harness.payload.update({
        collection: 'users',
        data: { organisation: orgA.id } as never,
        id: employer.id,
        user: adminA as never,
      }),
    ).resolves.toMatchObject({ id: employer.id })
  })

  it('refuses to link an organisation to a user who only seeks in that tenant', async () => {
    const employerAndSeeker = await makeUser('employer-and-seeker', [
      { role: 'employer', tenant: harness.tenantA.id },
      { role: 'seeker', tenant: harness.tenantB.id },
    ])
    const adminA = await makeUser('admin-a-seeker', [
      { role: 'tenant-admin', tenant: harness.tenantA.id },
    ])

    await expect(
      harness.payload.update({
        collection: 'users',
        data: { organisation: orgB.id } as never,
        id: employerAndSeeker.id,
        user: adminA as never,
      }),
    ).rejects.toThrow(/Organisation/)

    // Their own tenant still works.
    await expect(
      harness.payload.update({
        collection: 'users',
        data: { organisation: orgA.id } as never,
        id: employerAndSeeker.id,
        user: adminA as never,
      }),
    ).resolves.toMatchObject({ id: employerAndSeeker.id })
  })

  it('lets a super admin link an organisation without a tenant membership', async () => {
    const superAdmin = await makeUser('root-link', null, { role: 'super-admin' })

    await expect(
      harness.payload.update({
        collection: 'users',
        data: { organisation: orgB.id } as never,
        id: employer.id,
        user: superAdmin as never,
      }),
    ).resolves.toMatchObject({ id: employer.id })
  })

  it('refuses to demote a linked employer to seeker in their organisation’s tenant', async () => {
    // Otherwise users.organisation would outlive the role that justifies it, and the employer
    // scope would keep the profile open. The scope itself also re-checks the role (unit tests).
    await expect(
      harness.payload.update({
        collection: 'users',
        data: {
          tenants: [
            { role: 'seeker', tenant: harness.tenantA.id },
            { role: 'employer', tenant: harness.tenantB.id },
          ],
        } as never,
        id: employer.id,
        overrideAccess: true,
      }),
    ).rejects.toThrow(/Organisation/)

    // Unlink first, then the demotion is fine.
    await harness.payload.update({
      collection: 'users',
      data: { organisation: null } as never,
      id: employer.id,
      overrideAccess: true,
    })
    await expect(
      harness.payload.update({
        collection: 'users',
        data: { tenants: [{ role: 'seeker', tenant: harness.tenantA.id }] } as never,
        id: employer.id,
        overrideAccess: true,
      }),
    ).resolves.toMatchObject({ id: employer.id })
  })

  it('rejects a relation from another tenant', async () => {
    const otherArea = await harness.payload.create({
      collection: 'areas-of-focus',
      data: { name: 'Marine', slug: 'marine', tenant: harness.tenantB.id } as never,
      overrideAccess: true,
    })

    const error = await harness.payload
      .create({
        collection: 'organisations',
        data: {
          ...organisationData({ areasOfFocus: [otherArea.id], slug: 'cross-tenant' }),
          tenant: harness.tenantA.id,
        } as never,
        overrideAccess: true,
      })
      .catch((thrown: unknown) => thrown)

    expect(JSON.stringify(error)).toMatch(/areas of focus/)
  })

  it('accepts the same relations inside the tenant', async () => {
    const area = await harness.payload.create({
      collection: 'areas-of-focus',
      data: { name: 'Youth', slug: 'youth', tenant: harness.tenantA.id } as never,
      overrideAccess: true,
    })
    const town = await harness.payload.create({
      collection: 'locations',
      data: {
        kind: 'town',
        name: 'Port Vila',
        slug: 'port-vila',
        tenant: harness.tenantA.id,
      } as never,
      overrideAccess: true,
    })

    const created = await harness.payload.create({
      collection: 'organisations',
      data: {
        ...organisationData({ areasOfFocus: [area.id], location: town.id, slug: 'related' }),
        tenant: harness.tenantA.id,
      } as never,
      overrideAccess: true,
    })

    expect(created).toMatchObject({ slug: 'related' })
  })

  it('rejects an update that targets another tenant, before any hook runs', async () => {
    const error = await harness.payload
      .update({
        collection: 'organisations',
        data: { name: 'Hijacked', tenant: harness.tenantB.id } as never,
        id: orgA.id,
        user: employer as never,
      })
      .catch((thrown: unknown) => thrown)

    expect(error).toBeTruthy()
    expect((await stored(orgA.id)).name).toBe('Vanuatu Brewing')
  })

  it('stops an employer who belongs to two tenants moving their organisation', async () => {
    const bothTenants = await makeUser(
      'employer-both',
      [
        { role: 'employer', tenant: harness.tenantA.id },
        { role: 'employer', tenant: harness.tenantB.id },
      ],
      { organisation: orgA.id },
    )

    const error = await harness.payload
      .update({
        collection: 'organisations',
        data: { tenant: harness.tenantB.id } as never,
        id: orgA.id,
        user: bothTenants as never,
      })
      .catch((thrown: unknown) => thrown)

    expect(JSON.stringify(error)).toMatch(/Only a tenant admin of both tenants/)
    expect(JSON.stringify(await stored(orgA.id))).toContain(`"tenant":${harness.tenantA.id}`)
  })

  it('stops an admin of an unrelated tenant moving an organisation', async () => {
    // Admin of tenant B only: nothing about tenant A's organisation is theirs to move.
    const elsewhere = await makeUser(
      'admin-elsewhere',
      [
        { role: 'employer', tenant: harness.tenantA.id },
        { role: 'tenant-admin', tenant: harness.tenantB.id },
      ],
      { organisation: orgA.id },
    )

    const error = await harness.payload
      .update({
        collection: 'organisations',
        data: { tenant: harness.tenantB.id } as never,
        id: orgA.id,
        user: elsewhere as never,
      })
      .catch((thrown: unknown) => thrown)

    expect(JSON.stringify(error)).toMatch(/Only a tenant admin of both tenants/)
    expect(JSON.stringify(await stored(orgA.id))).toContain(`"tenant":${harness.tenantA.id}`)
  })

  it('lets an admin of both tenants move the organisation', async () => {
    const adminBoth = await makeUser('admin-both', [
      { role: 'tenant-admin', tenant: harness.tenantA.id },
      { role: 'tenant-admin', tenant: harness.tenantB.id },
    ])

    const moved = await harness.payload.update({
      collection: 'organisations',
      data: { tenant: harness.tenantB.id } as never,
      id: orgA.id,
      user: adminBoth as never,
    })

    const movedTenant = (moved as unknown as { tenant?: number | { id: number } }).tenant
    expect(typeof movedTenant === 'object' ? movedTenant?.id : movedTenant).toBe(harness.tenantB.id)

    // Put it back for the tests after this one.
    await harness.payload.update({
      collection: 'organisations',
      data: { tenant: harness.tenantA.id } as never,
      id: orgA.id,
      overrideAccess: true,
    })
  })

  it('resolves the employer’s organisation from a real login, not just a stubbed user', async () => {
    // The unit tests pass a hand-built user object; this goes through the JWT strategy, which
    // reads the user document back, so the relation the access checks rely on is the real one.
    const login = await harness.payload.login({
      collection: 'users',
      data: { email: employerEmail!, password: 'test-password' },
    })
    expect(login.token).toBeTruthy()

    const headers = new Headers({ Authorization: `JWT ${login.token}` })
    const { user } = await harness.payload.auth({ headers })
    const loggedIn = user as unknown as MissionControlUser

    expect(
      typeof loggedIn.organisation === 'object' && loggedIn.organisation !== null
        ? (loggedIn.organisation as { id: number }).id
        : loggedIn.organisation,
    ).toBe(orgA.id)

    const { docs } = await harness.payload.find({
      collection: 'organisations',
      user: user as never,
    })

    expect(docs.map((doc) => doc.id)).toEqual([orgA.id])
  })

  it('stores the employer’s organisation on the user', async () => {
    const user = (await harness.payload.findByID({
      collection: 'users',
      depth: 0,
      id: employer.id,
      overrideAccess: true,
    })) as { organisation?: unknown }

    const id = typeof user.organisation === 'object' && user.organisation !== null
      ? (user.organisation as { id: number }).id
      : user.organisation

    expect(id).toBe(orgA.id)
  })
})
