import type { CollectionConfig, GlobalConfig, PayloadRequest } from 'payload'
import { describe, expect, it, vi } from 'vitest'

import {
  ALL_CONTENT_SCOPE,
  contentVersionKey,
  createMemoryContentVersionStore,
  type ContentVersionStore,
} from '@mission-control/content-cache'

import {
  contentVersionHooks,
  tenantContentVersionHook,
  withContentVersionHooks,
  withGlobalContentVersions,
  withTenantContentVersions,
  type ContentVersionOptions,
} from './content-version'

type Doc = Record<string, unknown>

const tenants: Record<string, Doc> = {
  1: { id: 1, slug: 'vwok' },
  2: { id: 2, slug: 'hub', isAggregate: true },
}

const requestWith = (store: ContentVersionStore, tenantsByID: Record<string, Doc> = tenants) =>
  ({
    payload: {
      findByID: vi.fn(async ({ id }: { id: number | string }) => tenantsByID[String(id)] ?? null),
    },
  }) as unknown as PayloadRequest

const optionsFor = (store: ContentVersionStore): ContentVersionOptions => ({
  nextVersion: () => 'bumped',
  store: () => store,
  tenantsSlug: 'tenants',
})

const read = (store: ContentVersionStore, scope: string) =>
  store.get(contentVersionKey(scope))

const write = async (
  hooks: ReturnType<typeof contentVersionHooks>['afterChange'],
  req: PayloadRequest,
  write: { doc: Doc; operation?: 'create' | 'delete' | 'update'; previousDoc?: Doc },
) => {
  const [hook] = hooks
  if (!hook) throw new Error('no afterChange hook')

  return hook({ doc: write.doc, operation: write.operation ?? 'update', previousDoc: write.previousDoc ?? {}, req } as never)
}

describe('content version hooks @S-240', () => {
  it('bumps the document’s tenant and the aggregate scope on a write', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks(optionsFor(store))

    await write(hooks.afterChange, requestWith(store), {
      doc: { id: 10, tenant: 1 },
      previousDoc: { id: 10, tenant: 1 },
    })

    expect(await read(store, 'vwok')).toBe('bumped')
    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
  })

  it('bumps the site a document moved from as well as the one it moved to', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks(optionsFor(store))

    await write(hooks.afterChange, requestWith(store), {
      doc: { id: 10, tenant: 1 },
      previousDoc: { id: 10, tenant: 2 },
    })

    expect(await read(store, 'vwok')).toBe('bumped')
    expect(await read(store, 'hub')).toBe('bumped')
  })

  it('bumps the aggregate scope for a document that belongs to no site', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks(optionsFor(store))

    await write(hooks.afterChange, requestWith(store), { doc: { id: 10 } })

    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
    expect(await read(store, 'vwok')).toBeNull()
  })

  it('reads the tenant as a populated document as well as an id', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks(optionsFor(store))

    await write(hooks.afterChange, requestWith(store), { doc: { id: 10, tenant: { id: 1 } } })

    expect(await read(store, 'vwok')).toBe('bumped')
  })

  it('bumps on a delete too, so a removed job leaves the listing', async () => {
    const store = createMemoryContentVersionStore()
    const [hook] = contentVersionHooks(optionsFor(store)).afterDelete
    if (!hook) throw new Error('no afterDelete hook')
    const req = requestWith(store)

    await hook({ doc: { id: 10, tenant: 1 }, req } as never)

    expect(await read(store, 'vwok')).toBe('bumped')
    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
  })

  it('remembers a tenant slug across documents, so one publish is one lookup', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks(optionsFor(store))
    const req = requestWith(store)

    await write(hooks.afterChange, req, { doc: { id: 10, tenant: 1 } })
    await write(hooks.afterChange, req, { doc: { id: 11, tenant: 1 } })

    expect((req as unknown as { payload: { findByID: { mock: { calls: unknown[] } } } }).payload.findByID.mock.calls).toHaveLength(1)
  })

  it('leaves a skipped write alone, such as a view counter', async () => {
    const store = createMemoryContentVersionStore()
    const hooks = contentVersionHooks({ ...optionsFor(store), skip: () => true })

    await write(hooks.afterChange, requestWith(store), { doc: { id: 10, tenant: 1 } })

    expect(await read(store, 'vwok')).toBeNull()
  })

  it('is a no-op without a store, which is the Node CLI and a test without KV', async () => {
    const hooks = contentVersionHooks({ ...optionsFor(createMemoryContentVersionStore()), store: () => undefined })

    await expect(
      write(hooks.afterChange, requestWith(createMemoryContentVersionStore()), { doc: { id: 10, tenant: 1 } }),
    ).resolves.toEqual({ id: 10, tenant: 1 })
  })

  it('returns the document unchanged, so a hook after it sees what it wrote', async () => {
    const store = createMemoryContentVersionStore()
    const doc = { id: 10, tenant: 1, title: 'Chef' }

    const result = await write(contentVersionHooks(optionsFor(store)).afterChange, requestWith(store), { doc })

    expect(result).toBe(doc)
  })
})

describe('withContentVersionHooks @S-240', () => {
  const collections = [
    { slug: 'jobs', hooks: { afterChange: [vi.fn()] } },
    { slug: 'orders' },
    { slug: 'pages' },
  ] as unknown as CollectionConfig[]

  it('adds the hooks only to the collections whose writes a page renders', () => {
    const store = createMemoryContentVersionStore()
    const hooked = withContentVersionHooks(collections, optionsFor(store), new Set(['jobs', 'pages']))

    expect(hooked[0]?.hooks?.afterChange).toHaveLength(2)
    expect(hooked[1]?.hooks?.afterChange).toBeUndefined()
    expect(hooked[2]?.hooks?.afterChange).toHaveLength(1)
  })

  it('keeps the collection’s own hooks, so the bump never replaces one', () => {
    const store = createMemoryContentVersionStore()
    const own = vi.fn()
    const hooked = withContentVersionHooks(
      [{ slug: 'jobs', hooks: { afterChange: [own] } }] as unknown as CollectionConfig[],
      optionsFor(store),
      new Set(['jobs']),
    )

    expect(hooked[0]?.hooks?.afterChange?.[0]).toBe(own)
  })

  it('leaves every collection alone when no store is configured', () => {
    expect(withContentVersionHooks(collections, undefined, new Set(['jobs']))).toBe(collections)
  })
})

describe('site settings hooks @S-240', () => {
  it('bumps the tenant’s own slug and the aggregate scope when its row is saved', async () => {
    const store = createMemoryContentVersionStore()
    const hook = tenantContentVersionHook(optionsFor(store))

    await hook({ doc: { id: 1, slug: 'vwok' }, previousDoc: { id: 1, slug: 'vwok' }, req: requestWith(store) } as never)

    expect(await read(store, 'vwok')).toBe('bumped')
    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
  })

  it('bumps the old slug too when a tenant is renamed, so the old cache dies with the name', async () => {
    const store = createMemoryContentVersionStore()
    const hook = tenantContentVersionHook(optionsFor(store))

    await hook({
      doc: { id: 1, slug: 'vanuatu-wok' },
      previousDoc: { id: 1, slug: 'vwok' },
      req: requestWith(store),
    } as never)

    expect(await read(store, 'vanuatu-wok')).toBe('bumped')
    expect(await read(store, 'vwok')).toBe('bumped')
  })

  it('bumps only the aggregate scope for the hub’s own row', async () => {
    const store = createMemoryContentVersionStore()
    const hook = tenantContentVersionHook(optionsFor(store))

    await hook({
      doc: { id: 2, isAggregate: true, slug: 'hub' },
      previousDoc: { id: 2, isAggregate: true, slug: 'hub' },
      req: requestWith(store),
    } as never)

    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
    expect(await read(store, 'hub')).toBeNull()
  })

  it('adds the save and delete hooks to the tenants collection', () => {
    const store = createMemoryContentVersionStore()
    const tenantsCollection = { slug: 'tenants', hooks: {} } as CollectionConfig
    const hooked = withTenantContentVersions(tenantsCollection, optionsFor(store))

    expect(hooked.hooks?.afterChange).toHaveLength(1)
    expect(hooked.hooks?.afterDelete).toHaveLength(1)
  })
})

describe('single-tenant settings global @S-240', () => {
  it('bumps the site scope and the aggregate scope when the global is saved', async () => {
    const store = createMemoryContentVersionStore()
    const global = { slug: 'job-board-settings', hooks: {} } as GlobalConfig
    const hooked = withGlobalContentVersions(global, { ...optionsFor(store), siteScope: 'vwok' })
    const [hook] = hooked.hooks?.afterChange ?? []
    if (!hook) throw new Error('no global afterChange hook')

    await hook({ doc: {}, req: requestWith(store) } as never)

    expect(await read(store, 'vwok')).toBe('bumped')
    expect(await read(store, ALL_CONTENT_SCOPE)).toBe('bumped')
  })
})
