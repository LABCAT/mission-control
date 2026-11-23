import type {
  CollectionAfterChangeHook,
  CollectionAfterDeleteHook,
  CollectionConfig,
  CollectionSlug,
  GlobalConfig,
  PayloadRequest,
} from 'payload'

import {
  ALL_CONTENT_SCOPE,
  bumpContentVersions,
  type ContentVersionStore,
} from '@mission-control/content-cache'

import { tenantIDOf } from './catalog'

/**
 * Global cache invalidation for the sites (PJ-41).
 *
 * The Workers Cache API is per data centre, so a purge issued from the CMS clears only the colo
 * the CMS happens to run in. Instead each site puts its tenant's content version, kept in
 * Cloudflare KV, into its edge cache key; a content write bumps the version, so every colo misses
 * on its next request and renders fresh HTML.
 *
 * A tenant's own site is bumped by its slug, and every aggregate site (the hub) by
 * `ALL_CONTENT_SCOPE`, because a hub lists several tenants' content.
 */

export type ContentVersionWrite = {
  doc: unknown
  operation: 'create' | 'delete' | 'update'
  req: PayloadRequest
}

export type ContentVersionOptions = {
  /**
   * The store the sites read, normally an async getter for the KV binding, so the binding is read
   * inside the request (workerd forbids reading a binding at module scope). `undefined` turns the
   * hooks into no-ops, which is what the Node CLI and the tests without KV get.
   */
  store: () => ContentVersionStore | undefined | Promise<ContentVersionStore | undefined>
  /** Injectable for tests. Defaults to a random id, so two writes never agree. */
  nextVersion?: () => string
  /** Return true to leave a write alone, e.g. a job's view counter. */
  skip?: (write: ContentVersionWrite) => boolean
  /** The scope a single-tenant installation bumps. Default `default`. */
  siteScope?: string
  /** The tenants collection, for turning a document's tenant id into its site slug. */
  tenantsSlug?: string
}

type TenantDoc = { isAggregate?: null | boolean; slug?: null | string }

const siteSlugs = new WeakMap<object, Map<string, string>>()

/** A document's tenant, as an id, or null when it belongs to no site. */
const docTenantID = (doc: unknown): null | number | string =>
  tenantIDOf((doc as { tenant?: unknown } | null | undefined)?.tenant)

/**
 * One publish can touch many documents that share a tenant, so a slug lookup is remembered for
 * the life of the `payload` instance the request uses.
 */
const tenantSlug = async (
  req: PayloadRequest,
  tenantsSlug: string,
  id: number | string,
): Promise<null | string> => {
  const known = siteSlugs.get(req.payload) ?? new Map<string, string>()
  siteSlugs.set(req.payload, known)

  const key = String(id)
  const remembered = known.get(key)
  if (remembered) return remembered

  const tenant = (await req.payload.findByID({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    id,
    overrideAccess: true,
    req,
  })) as null | TenantDoc

  if (tenant?.slug) known.set(key, tenant.slug)

  return tenant?.slug ?? null
}

/** Bump each scope to a new version; the store is the only place a version lives. */
const bumpScopes = async (
  options: ContentVersionOptions,
  scopes: readonly string[],
): Promise<void> => {
  try {
    await bumpContentVersions(await options.store(), scopes, { nextVersion: options.nextVersion })
  } catch {
    // The binding getter threw: a missed bump is stale pages until the TTL, never a failed save.
  }
}

/**
 * The scopes a document's write affects: its own site, the site it moved from, and every
 * aggregate site. A tenantless document (a hub's own row) bumps only the aggregate scope.
 */
const bumpDoc = async (
  req: PayloadRequest,
  options: ContentVersionOptions,
  doc: unknown,
  previous: unknown,
): Promise<void> => {
  try {
    await bumpDocScopes(req, options, doc, previous)
  } catch {
    // A tenant lookup that fails must not fail the content write that triggered it.
  }
}

const bumpDocScopes = async (
  req: PayloadRequest,
  options: ContentVersionOptions,
  doc: unknown,
  previous: unknown,
): Promise<void> => {
  const tenantsSlug = options.tenantsSlug ?? 'tenants'
  const ids = [...new Set([docTenantID(doc), docTenantID(previous)].filter((id) => id !== null).map(String))]
  const slugs = await Promise.all(ids.map((id) => tenantSlug(req, tenantsSlug, id)))

  await bumpScopes(options, [...slugs.filter((slug): slug is string => Boolean(slug)), ALL_CONTENT_SCOPE])
}

/**
 * A tenant row's own scopes: its slug (before and after a rename) plus the aggregate scope, which
 * renders other tenants' settings too. A hub's own row has no tenant site, so only the aggregate.
 */
const tenantScopes = (doc: unknown, previous: unknown): string[] => {
  if ((doc as TenantDoc | null | undefined)?.isAggregate === true) return [ALL_CONTENT_SCOPE]

  const slugs = [doc, previous]
    .map((value) => (value as TenantDoc | null | undefined)?.slug)
    .filter((slug): slug is string => Boolean(slug))

  return [...slugs, ALL_CONTENT_SCOPE]
}

const skipped = (options: ContentVersionOptions, write: ContentVersionWrite): boolean =>
  options.skip?.(write) === true

/**
 * `afterChange` and `afterDelete` hooks for a tenant-scoped content collection. A tenant's own
 * site and every aggregate site drop their cached pages on any write.
 */
export const contentVersionHooks = (options: ContentVersionOptions): {
  afterChange: CollectionAfterChangeHook[]
  afterDelete: CollectionAfterDeleteHook[]
} => ({
  afterChange: [
    async ({ doc, operation, previousDoc, req }) => {
      if (!skipped(options, { doc, operation, req })) await bumpDoc(req, options, doc, previousDoc)
      return doc
    },
  ],
  afterDelete: [
    async ({ doc, req }) => {
      await bumpDoc(req, options, doc, null)
      return doc
    },
  ],
})

/** Add the bump hooks to a collection, keeping any hooks it already has. */
export const withContentVersions = (
  collection: CollectionConfig,
  options: ContentVersionOptions,
): CollectionConfig => {
  const hooks = contentVersionHooks(options)

  return {
    ...collection,
    hooks: {
      ...collection.hooks,
      afterChange: [...(collection.hooks?.afterChange ?? []), ...hooks.afterChange],
      afterDelete: [...(collection.hooks?.afterDelete ?? []), ...hooks.afterDelete],
    },
  }
}

/**
 * Add the bump hooks to every collection whose slug is in `slugs`, so the hook set is the same
 * for each and a collection outside the list (orders, applications, the ledger) is untouched.
 */
export const withContentVersionHooks = (
  collections: CollectionConfig[],
  options: ContentVersionOptions | undefined,
  slugs: ReadonlySet<string>,
): CollectionConfig[] =>
  options === undefined
    ? collections
    : collections.map((collection) =>
        slugs.has(collection.slug) ? withContentVersions(collection, options) : collection,
      )

/**
 * The tenants collection carries the site settings in multi-tenant mode, so a save there bumps
 * the tenant's own slug rather than a `tenant` field.
 */
export const tenantContentVersionHook =
  (options: ContentVersionOptions): CollectionAfterChangeHook =>
  async ({ doc, previousDoc }) => {
    await bumpScopes(options, tenantScopes(doc, previousDoc))
    return doc
  }

/** The same for a tenant delete. */
export const tenantContentVersionDeleteHook =
  (options: ContentVersionOptions): CollectionAfterDeleteHook =>
  async ({ doc }) => {
    await bumpScopes(options, tenantScopes(doc, null))
    return doc
  }

/** Add the bump hooks to the tenants collection, keeping any hooks it already has. */
export const withTenantContentVersions = (
  collection: CollectionConfig,
  options: ContentVersionOptions,
): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    afterChange: [...(collection.hooks?.afterChange ?? []), tenantContentVersionHook(options)],
    afterDelete: [...(collection.hooks?.afterDelete ?? []), tenantContentVersionDeleteHook(options)],
  },
})

/** The single-tenant settings global: one site, so its scope and the hub's. */
export const withGlobalContentVersions = (
  global: GlobalConfig,
  options: ContentVersionOptions,
): GlobalConfig => ({
  ...global,
  hooks: {
    ...global.hooks,
    afterChange: [
      ...(global.hooks?.afterChange ?? []),
      async ({ doc }) => {
        await bumpScopes(options, [options.siteScope ?? 'default', ALL_CONTENT_SCOPE])
        return doc
      },
    ],
  },
})
