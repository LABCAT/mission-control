import type {
  Access,
  CollectionAfterChangeHook,
  CollectionBeforeValidateHook,
  CollectionSlug,
  Endpoint,
  GlobalSlug,
  Payload,
  PayloadRequest,
  Where,
} from 'payload'
import { ValidationError } from 'payload'

import { isAddOnEnabled, type AddOnSettings } from './add-ons'
import { emitJobLifecycle, type PayloadJobsRegistry } from './payload-jobs-registry'
import type { JobLifecycleEvent } from './definitions'

/**
 * A disabled add-on exposes nothing for that tenant (PJ-115): its collections list empty and
 * refuse writes, its endpoints answer 404, its tabs, reports and email events drop out of
 * `forTenant`. These helpers are what add-on packages wrap their own parts with.
 */

type GateOptions = { key: string; registry: PayloadJobsRegistry }

const idOf = (value: unknown): null | number | string =>
  value && typeof value === 'object'
    ? idOf((value as { id?: unknown }).id)
    : typeof value === 'number' || typeof value === 'string'
      ? value
      : null

/** One tenant's settings (the tenant document, or the settings global in single mode). */
export const loadTenantSettings = async (
  registry: PayloadJobsRegistry,
  payload: Payload,
  tenantID: null | number | string,
  req?: PayloadRequest,
): Promise<AddOnSettings> => {
  const { settingsSlug, tenancy, tenantsSlug } = registry.context

  if (tenancy === 'single') {
    return (await payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      req,
      slug: settingsSlug as GlobalSlug,
    })) as AddOnSettings
  }
  if (tenantID === null) return null

  return (await payload.findByID({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    id: tenantID,
    overrideAccess: true,
    req,
  })) as AddOnSettings
}

/** IDs of every tenant that has the add-on on. */
export const tenantIDsWithAddOn = async (
  { key, registry }: GateOptions,
  payload: Payload,
  req?: PayloadRequest,
): Promise<(number | string)[]> => {
  const { docs } = await payload.find({
    collection: registry.context.tenantsSlug as CollectionSlug,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    req,
  })

  return docs.filter((doc) => isAddOnEnabled(doc as AddOnSettings, key)).map((doc) => doc.id)
}

/**
 * Wrap a collection access function: whatever it grants is narrowed to tenants that have the
 * add-on on. In single-tenant mode it denies outright when the settings switch the add-on off.
 * Use it on read, update and delete; writes that create need `addOnWriteGuard` too, because
 * create access cannot see the data.
 */
export const gateCollectionAccess =
  (options: GateOptions, access: Access): Access =>
  async (args) => {
    const result = await access(args)
    if (result === false) return false

    const { payload } = args.req

    if (options.registry.context.tenancy === 'single') {
      const settings = await loadTenantSettings(options.registry, payload, null, args.req)

      return isAddOnEnabled(settings, options.key) ? result : false
    }

    const enabled = await tenantIDsWithAddOn(options, payload, args.req)
    const gate: Where = { tenant: { in: enabled } }

    return result === true ? gate : { and: [result, gate] }
  }

/** Refuse creating or editing a document whose tenant has the add-on off. */
export const addOnWriteGuard =
  (options: GateOptions): CollectionBeforeValidateHook =>
  async ({ collection, data, originalDoc, req }) => {
    const tenancy = options.registry.context.tenancy
    const tenantID = tenancy === 'multi' ? (idOf(data?.tenant) ?? idOf(originalDoc?.tenant)) : null
    const settings = await loadTenantSettings(options.registry, req.payload, tenantID, req)

    if (!isAddOnEnabled(settings, options.key)) {
      throw new ValidationError({
        collection: collection.slug,
        errors: [{ message: `The ${options.key} add-on is switched off for this site`, path: 'tenant' }],
        req,
      })
    }

    return data
  }

/**
 * Wrap an endpoint so it answers 404 for a tenant with the add-on off. `resolveTenantID` says
 * which tenant the request is for (the host's own resolution, for example from the site key).
 */
export const gateEndpoint = (
  options: GateOptions,
  endpoint: Endpoint,
  resolveTenantID: (req: PayloadRequest) => null | number | string | Promise<null | number | string>,
): Endpoint => ({
  ...endpoint,
  handler: async (req) => {
    const tenantID = await resolveTenantID(req)
    const settings = await loadTenantSettings(options.registry, req.payload, tenantID, req)

    if (!isAddOnEnabled(settings, options.key)) return Response.json({ error: 'Not found' }, { status: 404 })

    return endpoint.handler(req)
  },
})

const LIFECYCLE_STATUS: Record<string, JobLifecycleEvent | undefined> = {
  cancelled: 'cancelled',
  expired: 'expired',
  published: 'published',
}

/**
 * Job `afterChange` hook: when the status changes to published, expired or cancelled, run the
 * lifecycle hooks of add-ons the job's tenant has on. A failing add-on is logged and never
 * fails the save (the job has been written already).
 */
export const jobLifecycleHook =
  (registry: PayloadJobsRegistry, jobsSlug: string): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    const event = LIFECYCLE_STATUS[String(doc?.status)]
    const previousStatus = operation === 'create' ? null : ((previousDoc?.status as string) ?? null)

    if (!event || previousStatus === doc.status) return doc

    const tenantID = registry.context.tenancy === 'multi' ? idOf(doc.tenant) : null
    const settings = await loadTenantSettings(registry, req.payload, tenantID, req)
    const errors = await emitJobLifecycle(
      registry,
      { event, job: doc, jobsSlug, payload: req.payload, previousStatus, req, tenantID },
      settings,
    )

    for (const error of errors) req.payload.logger.error({ err: error }, 'payload-jobs: lifecycle hook failed')

    return doc
  }
