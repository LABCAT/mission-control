import {
  ValidationError,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type CollectionSlug,
  type Field,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { anonymiseUser } from './anonymise-user'
import { hasAuditLog, writeAuditLog } from './audit-log'
import { APPLICATION_FILES_SLUG, APPLICATIONS_SLUG } from './collections/applications'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'
import { SYSTEM_PAGE_CLEANUP_CONTEXT } from './system-pages'

/**
 * Tenant offboarding (PJ-93, decision 19). A tenant is deleted only when it holds no data:
 * the delete is refused while any tenant-scoped collection still has documents for it, and the
 * offboarding clean-up empties those collections first.
 *
 * Two records are never removed: orders and the credit ledger. They are the accounting history
 * (S-146, S-149), so a tenant that has them cannot be offboarded or deleted at all; the result
 * names them instead.
 *
 * User accounts survive too, and are never hard-deleted. A member of several sites only loses
 * their membership of this one (the host's tenant `beforeDelete` hook, `removeTenantMemberships`
 * in the CMS). A member of this site alone would be left with a live account and all their
 * personal data on no site, so the offboarding run anonymises them with PJ-89's
 * `anonymiseUser`, scoped to the tenant (decision 19). The row stays, so the ledger's
 * `createdBy` references survive (PJ-24 review follow-up).
 */

/**
 * Set on `req.context` only by a deliberate whole-tenant clean-up, so the data guard steps aside
 * for the rows it removes. It is deliberately not the credit ledger's purge flag: a tenant with
 * credit rows must still be refused, so offboarding must not disarm the accounting guards.
 */
export const TENANT_OFFBOARDING_PURGE_CONTEXT = 'payloadJobsTenantOffboarding'

/**
 * The context an offboarding delete passes. System pages refuse deletion except under their own
 * cleanup flag, so a deliberate site clean-up sets that too.
 */
export const purgeContext = (): Record<string, unknown> => ({
  [SYSTEM_PAGE_CLEANUP_CONTEXT]: true,
  [TENANT_OFFBOARDING_PURGE_CONTEXT]: true,
})

/** The relationship field the multi-tenant plugin adds to a tenant-scoped collection. */
export const DEFAULT_TENANT_FIELD = 'tenant'

const fieldHasName = (field: Field, name: string): boolean =>
  'name' in field && field.name === name

/**
 * Collections the multi-tenant plugin scopes to a tenant: those with a `tenant` relationship.
 * The plugin adds the field to the top level of each collection it is given, so a shallow check
 * is enough, and a collection without it (`users`, whose memberships live in `tenants`) is never
 * treated as tenant data.
 */
export const tenantDataCollections = ({
  config,
  tenantField = DEFAULT_TENANT_FIELD,
  tenantsSlug = 'tenants',
}: {
  config: Pick<Payload['config'], 'collections'>
  tenantField?: string
  tenantsSlug?: string
}): string[] =>
  (config.collections ?? [])
    .filter((collection: CollectionConfig) => collection.slug !== tenantsSlug)
    .filter((collection: CollectionConfig) =>
      collection.fields.some((field) => fieldHasName(field, tenantField)),
    )
    .map((collection) => collection.slug)

export type TenantDataCount = { docs: number; slug: string }

/** Accounting records: kept even when the operator asks for everything else to go. */
export const accountingCollections = (slugs: PayloadJobsCollectionSlugs): string[] => [
  slugs.orders,
  slugs.creditLedger,
]

/**
 * A tenant `beforeDelete` hook that removes one or more collections' rows for the tenant, such as
 * the pages and menu cleanups. The marker tells the data guard that those rows never outlive the
 * tenant, so they are not data an operator has to offboard first.
 */
export type TenantCleanupHook = CollectionBeforeDeleteHook & {
  tenantCleanupCollections: readonly string[]
}

export const tenantCleanup = (
  collections: readonly string[],
  hook: CollectionBeforeDeleteHook,
): TenantCleanupHook => Object.assign(hook, { tenantCleanupCollections: collections })

/** The collections the tenants collection's own hooks remove when a tenant is deleted. */
export const selfCleanedCollections = (
  tenants: Pick<CollectionConfig, 'hooks'> | undefined,
): string[] =>
  (tenants?.hooks?.beforeDelete ?? []).flatMap((hook) => {
    const marked = (hook as Partial<TenantCleanupHook>).tenantCleanupCollections
    return Array.isArray(marked) ? marked : []
  })

const whereFor = (tenantField: string, tenant: number | string) => ({
  [tenantField]: { equals: tenant },
})

/** How many documents each tenant-scoped collection holds for one tenant; zero counts left out. */
export const tenantDataCounts = async ({
  collections,
  payload,
  req,
  tenant,
  tenantField = DEFAULT_TENANT_FIELD,
}: {
  collections: string[]
  payload: Payload
  req?: Partial<PayloadRequest>
  tenant: number | string
  tenantField?: string
}): Promise<TenantDataCount[]> => {
  const counts: TenantDataCount[] = []

  for (const slug of collections) {
    const { totalDocs } = await payload.count({
      collection: slug as CollectionSlug,
      overrideAccess: true,
      ...(req ? { req } : {}),
      where: whereFor(tenantField, tenant),
    })
    if (totalDocs > 0) counts.push({ docs: totalDocs, slug })
  }

  return counts
}

const idString = (value: unknown): string =>
  typeof value === 'object' && value !== null
    ? String((value as { id?: unknown }).id)
    : String(value)

/**
 * Users whose only membership is this tenant: nobody else can manage them once it is gone.
 * Super admins, and the person running the offboarding, are never included.
 */
export const tenantOnlyMembers = async ({
  actor,
  payload,
  req,
  tenant,
  usersSlug = 'users',
}: {
  actor?: number | string
  payload: Payload
  req?: Partial<PayloadRequest>
  tenant: number | string
  usersSlug?: string
}): Promise<(number | string)[]> => {
  const { docs } = await payload.find({
    collection: usersSlug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    ...(req ? { req } : {}),
    where: { 'tenants.tenant': { in: [tenant] } },
  })

  return (docs as unknown as { id: number | string; role?: string; tenants?: { tenant?: unknown }[] }[])
    .filter((user) => user.role !== 'super-admin')
    .filter((user) => actor === undefined || String(user.id) !== String(actor))
    .filter((user) => {
      const sites = new Set((user.tenants ?? []).map((entry) => idString(entry.tenant)))
      return sites.size === 1 && sites.has(String(tenant))
    })
    .map((user) => user.id)
}

const listed = (entries: TenantDataCount[]): string =>
  entries.map(({ docs, slug }) => `${docs} ${slug}`).join(', ')

const actorID = (req?: Partial<PayloadRequest>): number | string | undefined => {
  const id = (req?.user as { id?: number | string } | null | undefined)?.id
  return id === undefined ? undefined : id
}

/**
 * Append a tenant audit entry (S-122) when the host has the audit log, and never let a logging
 * failure change the outcome of the action it records. Pass `req` to keep the row inside the
 * action's transaction; omit it for a refusal that is about to throw.
 */
export const writeTenantAuditEntry = async ({
  action,
  actor,
  detail,
  payload,
  req,
  tenant,
}: {
  action: string
  actor?: number | string
  detail: Record<string, unknown>
  payload: Payload
  req?: Partial<PayloadRequest>
  tenant: number | string
}): Promise<void> => {
  if (actor === undefined || !hasAuditLog(payload)) return

  try {
    await writeAuditLog({
      entry: { action, actorID: actor, detail, tenantID: tenant },
      payload,
      ...(req ? { req: req as PayloadRequest } : {}),
    })
  } catch (error) {
    payload.logger.error({ err: error, msg: `tenant-offboarding: could not log "${action}"` })
  }
}

/**
 * Refuse to delete a tenant that still holds data, and say what has to go first. It runs before
 * the plugin's own clean-ups (pages, menus, coupons), so a blocked delete touches nothing.
 *
 * Two kinds of collection never block the delete, and both are found at request time, so a hook
 * an add-on appends later still counts:
 *
 * - the accounting collections, which have their own guards with their own messages;
 * - collections that a tenant `beforeDelete` hook removes anyway (`tenantCleanup`), because
 *   those rows never outlive the tenant.
 */
export const refuseDeleteWhileTenantHasData =
  ({
    except = [],
    slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenantField = DEFAULT_TENANT_FIELD,
    tenantsSlug = 'tenants',
  }: {
    /** More collections that never block the delete. */
    except?: string[]
    slugs?: PayloadJobsCollectionSlugs
    tenantField?: string
    tenantsSlug?: string
  } = {}): CollectionBeforeDeleteHook =>
  async ({ collection, id, req }) => {
    if (req.context?.[TENANT_OFFBOARDING_PURGE_CONTEXT] === true) return

    const tenants = req.payload.config.collections.find((entry) => entry.slug === tenantsSlug)
    const excluded = new Set([
      tenantsSlug,
      ...accountingCollections(slugs),
      ...selfCleanedCollections(tenants),
      ...except,
    ])
    const collections = tenantDataCollections({
      config: req.payload.config,
      tenantField,
      tenantsSlug,
    }).filter((slug) => !excluded.has(slug))
    const counts = await tenantDataCounts({
      collections,
      payload: req.payload,
      req,
      tenant: id,
      tenantField,
    })
    if (counts.length === 0) return

    // No `req`: the refusal throws, so the row must survive the rolled-back delete.
    await writeTenantAuditEntry({
      action: 'tenant.delete.blocked',
      actor: actorID(req),
      detail: { blocking: counts },
      payload: req.payload,
      tenant: id,
    })

    throw new ValidationError({
      collection: collection.slug,
      errors: [
        {
          message:
            `This tenant still has ${listed(counts)}, so it can’t be deleted. ` +
            'Offboard it first: remove that data, then delete the tenant.',
          path: 'id',
        },
      ],
      req,
    })
  }

/**
 * Record a successful tenant delete (S-122): who deleted which site. Runs inside the delete's
 * transaction, so a later hook that refuses leaves no entry behind. A request without a user
 * (a CLI run) writes its own entry through `writeTenantAuditEntry`.
 */
export const auditTenantDelete = (): CollectionBeforeDeleteHook => async ({ id, req }) => {
  await writeTenantAuditEntry({
    action: 'tenant.delete',
    actor: actorID(req),
    detail: {},
    payload: req.payload,
    req,
    tenant: id,
  })
}

/**
 * Delete order, most dependent first: applications point at jobs and files, jobs at plans and
 * organisations, plans at taxonomies and add-ons. Anything the list does not name (host uploads,
 * add-on collections) goes last, alphabetically, so the order stays predictable.
 */
const preferredOrder = (slugs: PayloadJobsCollectionSlugs): string[] => [
  APPLICATIONS_SLUG,
  APPLICATION_FILES_SLUG,
  slugs.jobs,
  slugs.plans,
  slugs.addOns,
  slugs.organisations,
  slugs.jobCategories,
  slugs.jobTypes,
  slugs.salaryBands,
  slugs.locations,
  // Submissions point at their form (PJ-102), so they go first.
  'form-submissions',
  'forms',
  slugs.pages,
  slugs.menus,
  slugs.coupons,
]

const inDeleteOrder = (collections: string[], slugs: PayloadJobsCollectionSlugs): string[] => {
  const preferred = preferredOrder(slugs)
  const rank = (slug: string): number => {
    const index = preferred.indexOf(slug)
    return index === -1 ? preferred.length : index
  }

  return [...collections].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export type TenantOffboardingOptions = {
  /**
   * Who asked for it, for the audit log (S-122). Defaults to the request's user; a CLI run with
   * no user passes its operator name, so the entry is never anonymous.
   */
  actor?: number | string
  /** Only count: nothing is deleted and nothing is written. @default false */
  dryRun?: boolean
  /** More collections to keep, e.g. an add-on's invoice records. */
  keep?: string[]
  payload: Payload
  /** Threads the caller's transaction and user, as any local API call does. */
  req?: Partial<PayloadRequest>
  slugs?: PayloadJobsCollectionSlugs
  tenant: number | string
  tenantField?: string
  tenantsSlug?: string
  /** Slug of the auth collection whose tenant-only members are anonymised. @default 'users' */
  usersSlug?: string
}

export type TenantOffboardingResult = {
  /** Users who belonged to this tenant alone and were anonymised (or, in a dry run, would be). */
  anonymisedUsers: (number | string)[]
  /** What the run removed, or (in a dry run) what it would remove. */
  removed: TenantDataCount[]
  /** Why a collection was left alone, or why nothing was removed at all. */
  errors: { message: string; slug: string }[]
  /** Accounting records and anything else the caller asked to keep, with their counts. */
  kept: TenantDataCount[]
  tenant: number | string
}

/**
 * Empty a tenant's job-board data so it can be deleted, or so the site can be closed.
 *
 * A dry run reports the plan. A real run refuses to touch anything while the tenant still has
 * accounting records, then deletes in dependency order under the offboarding purge context, and
 * keeps the accounting collections. Failures are collected per collection rather than thrown, so
 * one stubborn row does not hide the rest of the report.
 *
 * It never deletes the tenant row itself: that is a separate, explicit step (the CLI's
 * `--delete-tenant`), so an operator sees the result before the site's settings go.
 */
export const offboardTenant = async ({
  actor,
  dryRun = false,
  keep = [],
  payload,
  req,
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  tenant,
  tenantField = DEFAULT_TENANT_FIELD,
  tenantsSlug = 'tenants',
  usersSlug = 'users',
}: TenantOffboardingOptions): Promise<TenantOffboardingResult> => {
  const accounting = new Set(accountingCollections(slugs))
  const keptSlugs = new Set([...accounting, ...keep])
  const collections = tenantDataCollections({ config: payload.config, tenantField, tenantsSlug })
  const counts = await tenantDataCounts({ collections, payload, req, tenant, tenantField })

  const kept = counts.filter(({ slug }) => keptSlugs.has(slug))
  const removable = inDeleteOrder(
    counts.map(({ slug }) => slug).filter((slug) => !keptSlugs.has(slug)),
    slugs,
  )

  // Accounting records stop a real run, so they stop a dry run too: the plan must match what
  // the real run would do, or an operator reads "would remove jobs" and nothing is removed.
  const blocking = kept.filter(({ slug }) => accounting.has(slug))
  if (blocking.length > 0) {
    return {
      anonymisedUsers: [],
      errors: blocking.map(({ docs, slug }) => ({
        message: `This tenant has ${docs} ${slug} record${docs === 1 ? '' : 's'}, which are kept for accounting, so it can’t be offboarded`,
        slug,
      })),
      kept,
      removed: [],
      tenant,
    }
  }

  if (dryRun) {
    const bySlug = new Map(counts.map((count) => [count.slug, count.docs]))

    return {
      anonymisedUsers: await tenantOnlyMembers({
        ...(actor === undefined ? {} : { actor }),
        payload,
        req,
        tenant,
        usersSlug,
      }),
      errors: [],
      kept,
      removed: removable.map((slug) => ({ docs: bySlug.get(slug) ?? 0, slug })),
      tenant,
    }
  }

  const removed: TenantDataCount[] = []
  const errors: TenantOffboardingResult['errors'] = []

  for (const slug of removable) {
    const docs = counts.find((count) => count.slug === slug)?.docs ?? 0

    try {
      // A bulk delete reports a refused document in `errors` rather than throwing.
      const result = await payload.delete({
        collection: slug as CollectionSlug,
        context: purgeContext(),
        overrideAccess: true,
        ...(req ? { req } : {}),
        where: whereFor(tenantField, tenant),
      })
      const refused = (result as { errors?: { message?: string }[] }).errors ?? []
      if (refused.length > 0) {
        errors.push({
          message: refused.map((entry) => entry.message ?? 'delete refused').join('; '),
          slug,
        })
        continue
      }
      removed.push({ docs, slug })
    } catch (error) {
      errors.push({ message: error instanceof Error ? error.message : String(error), slug })
    }
  }

  // Members of this site alone are anonymised, never deleted. Only when everything else went:
  // a refused collection may still hold their data, and a rerun finds them again.
  const anonymisedUsers: (number | string)[] = []
  const operator = actor ?? actorID(req)

  if (errors.length === 0 && operator !== undefined) {
    const members = await tenantOnlyMembers({
      ...(operator === undefined ? {} : { actor: operator }),
      payload,
      req,
      tenant,
      usersSlug,
    })

    for (const userID of members) {
      try {
        await anonymiseUser({
          actorID: operator,
          auditTenantID: tenant,
          payload,
          reason: 'tenant offboarding',
          ...(req ? { req: req as PayloadRequest } : {}),
          scopeTenantIDs: [tenant],
          userID,
          usersSlug,
        })
        anonymisedUsers.push(userID)
      } catch (error) {
        errors.push({
          message: `Could not anonymise user ${userID}: ${error instanceof Error ? error.message : String(error)}`,
          slug: usersSlug,
        })
      }
    }
  }

  await writeTenantAuditEntry({
    action: 'tenant.offboard',
    actor: operator,
    // Counts and ids only: never the personal data that was removed.
    detail: { anonymisedUsers, errors, kept, removed },
    payload,
    req,
    tenant,
  })

  return { anonymisedUsers, errors, kept, removed, tenant }
}

/**
 * The tenant's documents, collection by collection, for the export that must happen before a
 * destructive run (data ownership and exit terms). Read with `overrideAccess`, so the export
 * holds the same rows the clean-up is about to remove; the caller decides where it goes.
 */
export const exportTenantData = async ({
  collections,
  payload,
  req,
  tenant,
  tenantField = DEFAULT_TENANT_FIELD,
  tenantsSlug = 'tenants',
}: {
  collections?: string[]
  payload: Payload
  req?: Partial<PayloadRequest>
  tenant: number | string
  tenantField?: string
  tenantsSlug?: string
}): Promise<{ docs: Record<string, unknown>[]; slug: string }[]> => {
  const slugs =
    collections ?? tenantDataCollections({ config: payload.config, tenantField, tenantsSlug })
  const exported: { docs: Record<string, unknown>[]; slug: string }[] = []

  for (const slug of slugs) {
    const { docs } = await payload.find({
      collection: slug as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      ...(req ? { req } : {}),
      where: whereFor(tenantField, tenant),
    })
    exported.push({ docs: docs as unknown as Record<string, unknown>[], slug })
  }

  return exported
}

/**
 * Delete the tenant row after an offboarding run, and record it (S-122). A CLI run has no request
 * user, so the `tenant.delete` hook cannot name anyone; the operator is recorded here instead.
 * The accounting guards still apply: no purge context is passed.
 */
export const deleteOffboardedTenant = async ({
  actor,
  payload,
  req,
  tenant,
  tenantsSlug = 'tenants',
}: {
  actor: number | string
  payload: Payload
  req?: Partial<PayloadRequest>
  tenant: number | string
  tenantsSlug?: string
}): Promise<void> => {
  await payload.delete({
    collection: tenantsSlug as CollectionSlug,
    id: tenant,
    overrideAccess: true,
    ...(req ? { req } : {}),
  })

  // A request with a user was already logged by the delete hook.
  if (actorID(req) !== undefined) return

  await writeTenantAuditEntry({ action: 'tenant.delete', actor, detail: {}, payload, req, tenant })
}
