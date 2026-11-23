import type { CollectionConfig, Config, Payload } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadJobs } from './index'
import { DEFAULT_PAYLOAD_JOBS_SLUGS } from './slugs'
import {
  accountingCollections,
  auditTenantDelete,
  exportTenantData,
  offboardTenant,
  purgeContext,
  refuseDeleteWhileTenantHasData,
  selfCleanedCollections,
  TENANT_OFFBOARDING_PURGE_CONTEXT,
  tenantCleanup,
  tenantDataCollections,
} from './tenant-offboarding'

const slugs = DEFAULT_PAYLOAD_JOBS_SLUGS

type FakeConfig = { collections: CollectionConfig[] }

/** A config whose collections declare the tenant field the multi-tenant plugin adds. */
const configWith = (...slugsWithTenant: string[]): FakeConfig => ({
  collections: [
    { slug: 'tenants', fields: [] },
    { slug: 'users', fields: [] },
    ...slugsWithTenant.map((slug) => ({ slug, fields: [{ name: 'tenant', type: 'relationship' }] })),
  ] as CollectionConfig[],
})

/** The module reads the sanitized config; a plain one carries the same slugs and fields. */
const asConfig = (config: FakeConfig) => config as unknown as Payload['config']

const fieldErrors = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((entry) => entry.message)
    .join(' | ')

type AuditRow = {
  action: string
  actorID: string
  detail: Record<string, unknown>
  tenantID?: string
}

type FakePayload = {
  audit: AuditRow[]
  config: FakeConfig
  counts: Record<string, number>
  deleted: { collection: string; context?: Record<string, unknown> }[]
  found: { collection: string }[]
  payload: Payload
}

const fakePayload = (
  config: FakeConfig,
  counts: Record<string, number> = {},
  // The audit log is opt-in: a host that never installed it keeps working.
  { auditLog = false }: { auditLog?: boolean } = {},
): FakePayload => {
  const deleted: FakePayload['deleted'] = []
  const found: FakePayload['found'] = []
  const audit: AuditRow[] = []
  const payload = {
    // Only a host with the collection registered (PJ-119) gets audit entries.
    collections: auditLog ? { 'audit-log': {} } : {},
    config,
    create: async ({ data }: { data: AuditRow }) => {
      audit.push(data)
      return data
    },
    logger: { error: () => undefined },
    count: async ({ collection }: { collection: string }) => ({
      totalDocs: counts[collection] ?? 0,
    }),
    delete: async ({ collection, context }: { collection: string; context?: Record<string, unknown> }) => {
      deleted.push({ collection, context })
      return { docs: [], errors: [] }
    },
    find: async ({ collection }: { collection: string }) => {
      found.push({ collection })
      return { docs: [{ id: 1, tenant: 7 }] }
    },
  } as unknown as Payload

  return { audit, config, counts, deleted, found, payload }
}

describe('tenant data collections', () => {
  it('lists the collections the multi-tenant plugin scopes, never the tenants or users', () => {
    const collections = tenantDataCollections({ config: asConfig(configWith('jobs', 'pages')) })

    expect(collections).toEqual(['jobs', 'pages'])
  })

  it('finds the collections a tenant cleanup hook removes @S-270', () => {
    const hook = tenantCleanup(['pages'], async () => undefined)
    const tenants = { hooks: { beforeDelete: [async () => undefined, hook] } }

    expect(selfCleanedCollections(tenants)).toEqual(['pages'])
    expect(selfCleanedCollections(undefined)).toEqual([])
  })
})

describe('refuseDeleteWhileTenantHasData @S-270', () => {
  it('refuses a tenant that still has job-board data and names it', async () => {
    const { payload } = fakePayload(configWith('jobs', 'pages'), { jobs: 2, pages: 1 })
    const guard = refuseDeleteWhileTenantHasData()

    await expect(
      guard({ collection: { slug: 'tenants' }, id: 7, req: { context: {}, payload } } as never),
    ).rejects.toSatisfy((error: unknown) =>
      /still has 2 jobs, 1 pages/.test(fieldErrors(error)),
    )
  })

  it('lets a tenant go once the collections are empty', async () => {
    const { payload } = fakePayload(configWith('jobs', 'pages'))
    const guard = refuseDeleteWhileTenantHasData()

    await expect(
      guard({ collection: { slug: 'tenants' }, id: 7, req: { context: {}, payload } } as never),
    ).resolves.toBeUndefined()
  })

  it('does not count the accounting collections, which have their own guards', async () => {
    const { payload } = fakePayload(configWith(slugs.orders, slugs.creditLedger))
    const guard = refuseDeleteWhileTenantHasData()

    await expect(
      guard({ collection: { slug: 'tenants' }, id: 7, req: { context: {}, payload } } as never),
    ).resolves.toBeUndefined()
    expect(accountingCollections(slugs)).toEqual([slugs.orders, slugs.creditLedger])
  })

  it('does not count collections the tenant’s own cleanup hooks remove', async () => {
    const pages = tenantCleanup([slugs.pages], async () => undefined)
    const config = configWith(slugs.pages, 'jobs')
    const { payload } = fakePayload(config, { jobs: 1, [slugs.pages]: 4 })
    const tenants = config.collections.find((collection) => collection.slug === 'tenants') as
      | { hooks?: CollectionConfig['hooks'] }
      | undefined
    if (tenants) tenants.hooks = { beforeDelete: [pages] }

    await expect(
      refuseDeleteWhileTenantHasData()({
        collection: { slug: 'tenants' },
        id: 7,
        req: { context: {}, payload },
      } as never),
    ).rejects.toSatisfy((error: unknown) => /1 jobs/.test(fieldErrors(error)))
  })

  it('steps aside under the offboarding purge context', async () => {
    const { payload } = fakePayload(configWith('jobs'), { jobs: 9 })

    await expect(
      refuseDeleteWhileTenantHasData()({
        collection: { slug: 'tenants' },
        id: 7,
        req: { context: purgeContext(), payload },
      } as never),
    ).resolves.toBeUndefined()
    expect(purgeContext()[TENANT_OFFBOARDING_PURGE_CONTEXT]).toBe(true)
  })
})

describe('offboardTenant @S-271', () => {
  it('reports what a dry run would remove and deletes nothing', async () => {
    const { deleted, payload } = fakePayload(configWith('jobs', 'organisations'), { jobs: 3, organisations: 1 })

    const result = await offboardTenant({ dryRun: true, payload, tenant: 7 })

    expect(result.removed).toEqual([
      { docs: 3, slug: 'jobs' },
      { docs: 1, slug: 'organisations' },
    ])
    expect(deleted).toEqual([])
  })

  it('removes in dependency order, under the purge context', async () => {
    const { deleted, payload } = fakePayload(configWith('organisations', 'jobs', 'plans'), {
      jobs: 1,
      organisations: 1,
      plans: 1,
    })

    const result = await offboardTenant({ payload, tenant: 7 })

    expect(result.removed.map(({ slug }) => slug)).toEqual(['jobs', 'plans', 'organisations'])
    expect(result.errors).toEqual([])
    expect(deleted.map(({ collection }) => collection)).toEqual(['jobs', 'plans', 'organisations'])
    expect(deleted.every(({ context }) => context?.[TENANT_OFFBOARDING_PURGE_CONTEXT] === true)).toBe(true)
  })

  it('refuses to offboard a tenant that still has accounting records', async () => {
    const { deleted, payload } = fakePayload(configWith('jobs', slugs.orders), { jobs: 1, [slugs.orders]: 2 })

    const result = await offboardTenant({ payload, tenant: 7 })

    expect(result.removed).toEqual([])
    expect(deleted).toEqual([])
    expect(result.errors).toEqual([
      expect.objectContaining({ slug: slugs.orders, message: expect.stringMatching(/kept for accounting/) }),
    ])
    expect(result.kept).toEqual([{ docs: 2, slug: slugs.orders }])
  })

  it('keeps collections the caller names, such as an add-on’s invoices', async () => {
    const { deleted, payload } = fakePayload(configWith('jobs', 'xero-invoices'), { jobs: 1, 'xero-invoices': 5 })

    const result = await offboardTenant({ keep: ['xero-invoices'], payload, tenant: 7 })

    expect(result.kept).toEqual([{ docs: 5, slug: 'xero-invoices' }])
    expect(deleted.map(({ collection }) => collection)).toEqual(['jobs'])
  })

  it('collects a refused collection as an error and carries on', async () => {
    const { payload } = fakePayload(configWith('jobs', 'pages'), { jobs: 1, pages: 1 })
    const failing = {
      ...payload,
      delete: async ({ collection }: { collection: string }) => {
        if (collection === 'jobs') throw new Error('still referenced')
        return { docs: [], errors: [] }
      },
    } as unknown as Payload

    const result = await offboardTenant({ payload: failing, tenant: 7 })

    expect(result.errors).toEqual([{ message: 'still referenced', slug: 'jobs' }])
    expect(result.removed).toEqual([{ docs: 1, slug: 'pages' }])
  })
})

describe('exportTenantData @S-272', () => {
  it('reads each tenant collection with override access, so the export matches what goes', async () => {
    const { found, payload } = fakePayload(configWith('jobs', 'pages'))

    const exported = await exportTenantData({ payload, tenant: 7 })

    expect(exported.map(({ slug }) => slug)).toEqual(['jobs', 'pages'])
    expect(found.map(({ collection }) => collection)).toEqual(['jobs', 'pages'])
    expect(exported[0]?.docs).toEqual([{ id: 1, tenant: 7 }])
  })
})

/** The plugin wires the guard before its own cleanups, and marks those cleanups. */
describe('plugin wiring', () => {
  const build = async () => {
    const base = {
      collections: [
        { slug: 'users', fields: [], auth: { verify: true } },
        { slug: 'tenants', fields: [] },
      ],
      secret: 'test',
    } as unknown as Config

    const result = await payloadJobs({ tenancy: 'multi' })(base)
    const tenants = result.collections?.find((collection) => collection.slug === 'tenants')

    return { result, tenants }
  }

  it('registers the data guard, after the order and credit guards @S-270', async () => {
    const { tenants } = await build()
    const hooks = tenants?.hooks?.beforeDelete ?? []

    // Orders, credits, this guard, the delete audit entry, then the pages, menus and coupon
    // cleanups.
    expect(hooks).toHaveLength(7)
    expect(hooks[2]).toBeTypeOf('function')
    expect(selfCleanedCollections(tenants)).not.toContain('jobs')
    // The pages, menus and coupons cleanups are marked, so the guard leaves them out.
    expect(selfCleanedCollections(tenants).sort()).toEqual(['coupons', 'menus', 'pages'])
  })

  it('honours renamed slugs, including the accounting exclusions @S-270', async () => {
    const base = {
      collections: [
        { slug: 'users', fields: [], auth: { verify: true } },
        { slug: 'tenants', fields: [] },
      ],
      secret: 'test',
    } as unknown as Config
    const result = await payloadJobs({
      collections: { orders: { slug: 'purchases' } },
      tenancy: 'multi',
    })(base)

    // The multi-tenant plugin adds the tenant field; the fake config must carry it too.
    const collections = (result.collections ?? []).map((collection) =>
      collection.slug === 'tenants' || collection.slug === 'users'
        ? collection
        : { ...collection, fields: [...collection.fields, { name: 'tenant', type: 'relationship' } as const] },
    )
    const { payload } = fakePayload({ collections: collections as CollectionConfig[] }, { jobs: 1, purchases: 3 })
    const guard = result.collections
      ?.find((collection) => collection.slug === 'tenants')
      ?.hooks?.beforeDelete?.[2]

    // Orders are kept for accounting under their new slug, so they never block this guard.
    await expect(
      (guard as (args: unknown) => Promise<void>)({
        collection: { slug: 'tenants' },
        id: 7,
        req: { context: {}, payload },
      }),
    ).rejects.toSatisfy((error: unknown) => /1 jobs/.test(fieldErrors(error)))
  })
})

describe('offboarding audit entries @S-122', () => {
  it('records a blocked delete, outside the transaction that rolls back', async () => {
    const { audit, payload } = fakePayload(configWith('jobs'), { jobs: 2 }, { auditLog: true })
    const guard = refuseDeleteWhileTenantHasData()

    await expect(
      guard({
        collection: { slug: 'tenants' },
        id: 7,
        req: { context: {}, payload, user: { id: 99 } },
      } as never),
    ).rejects.toThrow()

    expect(audit).toEqual([
      expect.objectContaining({
        action: 'tenant.delete.blocked',
        actorID: '99',
        detail: { blocking: [{ docs: 2, slug: 'jobs' }] },
        tenantID: '7',
      }),
    ])
  })

  it('records who deleted the site, inside the delete transaction', async () => {
    const { audit, payload } = fakePayload(configWith('jobs'), {}, { auditLog: true })
    const hook = auditTenantDelete()

    await hook({
      collection: { slug: 'tenants' },
      id: 7,
      req: { context: {}, payload, user: { id: 99 } },
    } as never)

    expect(audit).toEqual([
      expect.objectContaining({ action: 'tenant.delete', actorID: '99', tenantID: '7' }),
    ])
  })

  it('records an offboarding run with the operator the CLI names', async () => {
    const { audit, payload } = fakePayload(configWith('jobs'), { jobs: 1 }, { auditLog: true })

    const result = await offboardTenant({ actor: 'ops@example.com', payload, tenant: 7 })

    expect(audit).toEqual([
      expect.objectContaining({
        action: 'tenant.offboard',
        actorID: 'ops@example.com',
        detail: {
          errors: [],
          kept: [],
          removed: [{ docs: 1, slug: 'jobs' }],
        },
        tenantID: '7',
      }),
    ])
    expect(result.removed).toEqual([{ docs: 1, slug: 'jobs' }])
  })

  it('stays quiet without an audit log, and when nobody is named', async () => {
    const withoutLog = fakePayload(configWith('jobs'), { jobs: 1 })
    await expect(
      offboardTenant({ actor: 'ops', payload: withoutLog.payload, tenant: 7 }),
    ).resolves.toBeDefined()
    expect(withoutLog.audit).toEqual([])

    const anonymous = fakePayload(configWith('jobs'), { jobs: 1 }, { auditLog: true })
    await offboardTenant({ payload: anonymous.payload, tenant: 7 })
    expect(anonymous.audit).toEqual([])
  })

  it('never fails the action when the audit write fails', async () => {
    const { payload } = fakePayload(configWith('jobs'), { jobs: 1 }, { auditLog: true })
    ;(payload as unknown as { create: () => Promise<never> }).create = async () => {
      throw new Error('audit is down')
    }

    await expect(offboardTenant({ actor: 'ops', payload, tenant: 7 })).resolves.toMatchObject({
      removed: [{ docs: 1, slug: 'jobs' }],
    })
  })
})
