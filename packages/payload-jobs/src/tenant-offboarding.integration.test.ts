import type { CollectionBeforeDeleteHook, CollectionConfig, Field } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { addOnCollection } from './add-ons'
import { AUDIT_LOG_SLUG, auditLogCollection } from './audit-log'
import { applicationFilesCollection, applicationsCollection } from './collections/applications'
import { jobsCollection } from './collections/jobs'
import { locationsCollection } from './collections/locations'
import { menusCollection, removeTenantMenus } from './collections/menus'
import { organisationField, organisationsCollection } from './collections/organisations'
import { pagesCollection } from './collections/pages'
import { creditLedgerCollection, refuseDeleteWhileInCreditLedger } from './credits'
import { orderCollection, refuseDeleteWhileOrdered } from './orders'
import { planCollection } from './plans'
import { taxonomyCollections } from './taxonomies'
import { removeTenantPages } from './system-pages'
import { bootTestPayload, type TestHarness } from './test'
import {
  auditTenantDelete,
  offboardTenant,
  purgeContext,
  refuseDeleteWhileTenantHasData,
  tenantCleanup,
} from './tenant-offboarding'

const tenantFields: Field[] = [
  { name: 'currency', type: 'text' },
  { name: 'isAggregate', type: 'checkbox', defaultValue: false },
]
const tenantData = (which: 'A' | 'B') => ({ currency: which === 'A' ? 'VUV' : 'NZD' })

const collections = (): CollectionConfig[] => [
  locationsCollection({ requireTenant: true }),
  pagesCollection({ mediaSlug: null }),
  menusCollection(),
  organisationsCollection({ mediaSlug: null }),
  jobsCollection({ richTextDescription: false }),
  // The anonymiser deletes a person's applications and CVs with them.
  applicationFilesCollection({ tenantScoped: true }),
  applicationsCollection({ tenantScoped: true }),
  planCollection(),
  addOnCollection(),
  orderCollection({ couponsEnabled: false }),
  creditLedgerCollection(),
  ...taxonomyCollections({ tenantScoped: true }),
]

/** A slug the collections' validators accept, unique per document. */
const slugFor = (name: string): string =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 8)}`

/**
 * The host's own tenant hook (apps/cms `removeTenantMemberships`): users_tenants.tenant_id is
 * NOT NULL, so the membership rows go before the tenant row, and the accounts stay.
 */
const removeMemberships: CollectionBeforeDeleteHook = async ({ id, req }) => {
  const { docs } = await req.payload.find({
    collection: 'users',
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
    where: { 'tenants.tenant': { in: [id] } },
  })

  for (const user of docs) {
    const memberships = ((user as { tenants?: { tenant?: unknown }[] }).tenants ?? []).filter(
      (row) => String((row.tenant as { id?: unknown })?.id ?? row.tenant) !== String(id),
    )
    await req.payload.update({
      collection: 'users',
      data: { tenants: memberships } as never,
      id: user.id,
      overrideAccess: true,
      req,
    })
  }
}

// The same hook order the plugin builds in apps/cms: the host's own hooks, then the accounting
// guards, then the data guard, the delete audit entry, then the cleanups.
const tenantHooks = {
  beforeDelete: [
    removeMemberships,
    refuseDeleteWhileOrdered({ field: 'tenant', noun: 'tenant' }),
    refuseDeleteWhileInCreditLedger({ field: 'tenant', ledgerSlug: 'credit-ledger', noun: 'tenant' }),
    refuseDeleteWhileTenantHasData(),
    auditTenantDelete(),
    tenantCleanup(['pages'], removeTenantPages()),
    tenantCleanup(['menus'], removeTenantMenus()),
  ],
}

const fieldErrors = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((entry) => entry.message)
    .join(' | ')

describe('tenant offboarding against Postgres', () => {
  let harness: TestHarness

  const system = { overrideAccess: true } as const

  const makeTenant = async (name: string) =>
    (await harness.payload.create({
      collection: 'tenants',
      data: { currency: 'VUV', name, slug: slugFor(name) } as never,
      ...system,
    })) as unknown as { id: number; slug: string }

  const org = async (tenant: number, name: string) =>
    (await harness.payload.create({
      collection: 'organisations',
      data: { name, slug: slugFor(name), tenant },
      ...system,
    })) as unknown as { id: number }

  const job = async (tenant: number, organisation: number, title: string) =>
    (await harness.payload.create({
      collection: 'jobs',
      data: { organisation, tenant, title },
      ...system,
    })) as unknown as { id: number }

  const tenantExists = async (id: number): Promise<boolean> =>
    (await harness.payload
      .findByID({ collection: 'tenants', depth: 0, id, overrideAccess: true })
      .catch(() => null)) !== null

  const countOf = async (slug: string, tenant: number): Promise<number> => {
    const { totalDocs } = await harness.payload.count({
      collection: slug as never,
      overrideAccess: true,
      where: { tenant: { equals: tenant } },
    })
    return totalDocs
  }

  beforeAll(async () => {
    harness = await bootTestPayload({
      collections: collections(),
      globalCollections: [auditLogCollection()],
      tenantData,
      tenantFields,
      tenantHooks,
      userFields: [organisationField()],
    })
  }, 120_000)

  afterAll(async () => {
    if (harness) await harness.destroy()
  })

  it('refuses a tenant that still has job-board data, and deletes nothing @S-270', async () => {
    const tenant = await makeTenant('Blocked')
    const organisation = await org(tenant.id, 'Blocked Org')
    await job(tenant.id, organisation.id, 'Blocked job')
    await harness.payload.create({
      collection: 'menus',
      data: { location: 'primary', name: 'Primary', tenant: tenant.id } as never,
      ...system,
    })

    await expect(
      harness.payload.delete({ collection: 'tenants', id: tenant.id, ...system }),
    ).rejects.toSatisfy((error: unknown) => /1 jobs/.test(fieldErrors(error)))

    // The guard runs before the cleanups, so a refused delete leaves the site's pages and menus.
    expect(await countOf('jobs', tenant.id)).toBe(1)
    expect(await countOf('menus', tenant.id)).toBe(1)
    expect(await tenantExists(tenant.id)).toBe(true)
  })

  it('offboards a tenant in dependency order, then lets it be deleted @S-271', async () => {
    const tenant = await makeTenant('Leaving')
    const organisation = await org(tenant.id, 'Leaving Org')
    await job(tenant.id, organisation.id, 'Leaving job')
    await harness.payload.create({
      collection: 'plans',
      data: { durationDays: 30, jobCredits: 1, key: 'regular', name: 'Regular', price: 5000, tenant: tenant.id },
      ...system,
    })

    const dryRun = await offboardTenant({ dryRun: true, payload: harness.payload, tenant: tenant.id })
    expect(dryRun.removed).toEqual([
      { docs: 1, slug: 'jobs' },
      { docs: 1, slug: 'plans' },
      { docs: 1, slug: 'organisations' },
    ])
    expect(await countOf('jobs', tenant.id)).toBe(1)

    const result = await offboardTenant({ payload: harness.payload, tenant: tenant.id })
    expect(result.errors).toEqual([])
    expect(result.removed.map(({ slug }) => slug)).toEqual(['jobs', 'plans', 'organisations'])
    for (const slug of ['jobs', 'plans', 'organisations']) {
      expect(await countOf(slug, tenant.id)).toBe(0)
    }

    await harness.payload.delete({ collection: 'tenants', id: tenant.id, ...system })
    expect(await tenantExists(tenant.id)).toBe(false)
  })

  it('keeps user accounts: only the membership of the deleted tenant goes @S-271', async () => {
    const tenant = await makeTenant('Members')
    const member = (await harness.payload.create({
      collection: 'users',
      data: {
        email: `leaver-${Date.now()}@example.invalid`,
        password: 'test-password',
        role: 'user',
        tenants: [
          { role: 'editor', tenant: tenant.id },
          { role: 'editor', tenant: harness.tenantA.id },
        ],
      },
      ...system,
    })) as unknown as { id: number }

    await harness.payload.delete({ collection: 'tenants', id: tenant.id, ...system })

    const readBack = (await harness.payload.findByID({
      collection: 'users',
      depth: 0,
      id: member.id,
      ...system,
    })) as unknown as { tenants: { tenant: number | { id: number } }[] }

    expect(readBack).not.toBeNull()
    expect(readBack.tenants.map((row) => (typeof row.tenant === 'object' ? row.tenant.id : row.tenant))).toEqual([
      harness.tenantA.id,
    ])

    await harness.payload.delete({ collection: 'users', id: member.id, ...system })
  })

  it('anonymises a member of this site alone, keeping the row and anyone with another site @S-271', async () => {
    const tenant = await makeTenant('Sole')
    const makeUser = async (label: string, tenants: number[], role = 'user') =>
      (await harness.payload.create({
        collection: 'users',
        data: {
          email: `${label}-${Date.now()}@example.invalid`,
          password: 'test-password',
          role,
          tenants: tenants.map((id) => ({ role: 'editor', tenant: id })),
        },
        ...system,
      })) as unknown as { id: number }
    const emailOf = async (id: number): Promise<string> =>
      ((await harness.payload.findByID({ collection: 'users', depth: 0, id, ...system })) as unknown as {
        email: string
      }).email

    const operator = await makeUser('operator', [], 'super-admin')
    const sole = await makeUser('sole', [tenant.id])
    const shared = await makeUser('shared', [tenant.id, harness.tenantA.id])
    const admin = await makeUser('admin', [tenant.id], 'super-admin')
    const sharedEmail = await emailOf(shared.id)
    const adminEmail = await emailOf(admin.id)

    const dryRun = await offboardTenant({
      actor: operator.id,
      dryRun: true,
      payload: harness.payload,
      tenant: tenant.id,
    })
    expect(dryRun.anonymisedUsers).toEqual([sole.id])
    expect(await emailOf(sole.id)).not.toMatch(/removed\.invalid$/)

    const result = await offboardTenant({ actor: operator.id, payload: harness.payload, tenant: tenant.id })
    expect(result.errors).toEqual([])
    expect(result.anonymisedUsers).toEqual([sole.id])

    // The row survives (orders and the ledger point at it), but holds no personal data.
    const soleRow = (await harness.payload.findByID({
      collection: 'users',
      depth: 0,
      id: sole.id,
      ...system,
    })) as unknown as { email: string; tenants?: unknown[] }
    expect(soleRow.email).toBe(`removed-user-${sole.id}@removed.invalid`)
    expect(soleRow.tenants ?? []).toEqual([])

    // A member of another site, and a super admin, are left alone.
    expect(await emailOf(shared.id)).toBe(sharedEmail)
    expect(await emailOf(admin.id)).toBe(adminEmail)

    await harness.payload.delete({ collection: 'tenants', id: tenant.id, ...system })
    expect(await tenantExists(tenant.id)).toBe(false)
    expect(await emailOf(sole.id)).toBe(`removed-user-${sole.id}@removed.invalid`)

    for (const id of [sole.id, shared.id, admin.id, operator.id]) {
      await harness.payload.delete({
        collection: 'users',
        context: { payloadJobsPurge: true },
        id,
        ...system,
      })
    }
  })

  it('removes a site’s pages and menus with it, and reports only what the operator must clear @S-270', async () => {
    const tenant = await makeTenant('Clean')
    await harness.payload.create({
      collection: 'pages',
      data: { slug: 'about', tenant: tenant.id, title: 'About' } as never,
      ...system,
    })
    expect(await countOf('pages', tenant.id)).toBe(1)

    // The pages and menus never block the delete: the tenant's own hooks remove them, so the
    // guard's refusal (below) is what proves they are exempt, not the offboarding report.
    const result = await offboardTenant({ payload: harness.payload, tenant: tenant.id })
    expect(result.removed).toEqual([{ docs: 1, slug: 'pages' }])
    expect(result.errors).toEqual([])
    await harness.payload.delete({ collection: 'tenants', id: tenant.id, ...system })
    expect(await countOf('pages', tenant.id)).toBe(0)
  })

  it('leaves accounting collections alone and names them in the result @S-271', async () => {
    const tenant = await makeTenant('Accounted')
    const organisation = await org(tenant.id, 'Accounted Org')

    // A credit row is the accounting history; it can only be written by system code.
    await harness.payload.create({
      collection: 'credit-ledger',
      data: { delta: 5, note: 'Opening balance', organisation: organisation.id, reason: 'adjustment', tenant: tenant.id },
      ...system,
    })

    const result = await offboardTenant({ payload: harness.payload, tenant: tenant.id })

    expect(result.removed).toEqual([])
    expect(result.kept).toEqual([{ docs: 1, slug: 'credit-ledger' }])
    expect(result.errors).toEqual([
      expect.objectContaining({ slug: 'credit-ledger', message: expect.stringMatching(/kept for accounting/) }),
    ])
    expect(await countOf('credit-ledger', tenant.id)).toBe(1)

    // Offboarding's own purge context does not disarm the accounting guards: the tenant delete
    // is still refused, so the history cannot be detached from a deleted site.
    await expect(
      harness.payload.delete({ collection: 'tenants', id: tenant.id, context: purgeContext(), ...system }),
    ).rejects.toSatisfy((error: unknown) => /credit movement/.test(fieldErrors(error)))
  })

  it('records the blocked delete and the completed one in the audit log @S-122', async () => {
    const auditRows = async (tenant: number) =>
      (
        await harness.payload.find({
          collection: AUDIT_LOG_SLUG as never,
          overrideAccess: true,
          pagination: false,
          where: { tenantID: { equals: String(tenant) } },
        })
      ).docs as unknown as { action: string; actorID: string }[]

    const blocked = await makeTenant('Audited')
    const blockedOrg = await org(blocked.id, 'Audited Org')
    await job(blocked.id, blockedOrg.id, 'Audited job')

    await expect(
      harness.payload.delete({
        collection: 'tenants',
        id: blocked.id,
        overrideAccess: true,
        user: harness.superAdmin as never,
      }),
    ).rejects.toThrow()

    // The refusal is logged outside the rolled-back transaction, so the entry survives.
    expect(await auditRows(blocked.id)).toEqual([
      expect.objectContaining({ action: 'tenant.delete.blocked', actorID: String(harness.superAdmin.id) }),
    ])

    const deleted = await makeTenant('Audited clean')
    await harness.payload.delete({
      collection: 'tenants',
      id: deleted.id,
      overrideAccess: true,
      user: harness.superAdmin as never,
    })

    expect(await auditRows(deleted.id)).toEqual([
      expect.objectContaining({ action: 'tenant.delete', actorID: String(harness.superAdmin.id) }),
    ])
  })
})
