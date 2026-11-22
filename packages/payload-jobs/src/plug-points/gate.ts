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
import { emitJobLifecycle, emitOrderEvent, forTenant, type PayloadJobsRegistry } from './payload-jobs-registry'
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

/**
 * Set this on `req.context` to an empty array to defer order events: `orderEventHook` then
 * queues adapters' durable work in the request's transaction and records each event here, and
 * the caller emits them with `emitDeferredOrderEvents` once the transaction has committed.
 */
export const ORDER_EVENTS_DEFER_CONTEXT = 'payloadJobsDeferOrderEvents'

export type DeferredOrderEvent = {
  from: null | string
  kind: 'created' | 'statusChanged'
  orderID: number | string
  status: string
  tenantID: null | number | string
}

/**
 * Emit events recorded under `ORDER_EVENTS_DEFER_CONTEXT`, in order, after the transaction that
 * wrote them committed. Runs with a request of its own (no transaction); like the hook, an
 * adapter failing is logged, never thrown. Returns the errors.
 */
export const emitDeferredOrderEvents = async (
  registry: PayloadJobsRegistry,
  payload: Payload,
  events: readonly DeferredOrderEvent[],
  req?: PayloadRequest,
): Promise<Error[]> => {
  const errors: Error[] = []
  for (const event of events) {
    const settings = await loadTenantSettings(registry, payload, event.tenantID, req)
    const failed = await emitOrderEvent(
      registry,
      event.kind,
      { orderID: event.orderID, payload, req, status: event.status, tenantID: event.tenantID, ...(event.from === null ? {} : { from: event.from }) },
      settings,
    )
    for (const error of failed) payload.logger.error({ err: error }, 'payload-jobs: invoice sync adapter failed')
    errors.push(...failed)
  }
  return errors
}

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

/**
 * Tell the invoice-sync adapters (PJ-115 plug point 6) that an order was created or changed
 * status. Runs in the order's `afterChange`, so adapters get the request (and its transaction).
 * Like the lifecycle hooks, a failing adapter is logged and never fails the order's save.
 */
export const orderEventHook =
  (registry: PayloadJobsRegistry): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    if (registry.invoiceSync.list().length === 0) return doc

    const status = String(doc?.status ?? '')
    const from = operation === 'create' ? null : ((previousDoc?.status as string | undefined) ?? null)
    if (operation !== 'create' && from === status) return doc

    const tenantID = registry.context.tenancy === 'multi' ? idOf(doc.tenant) : null
    const settings = await loadTenantSettings(registry, req.payload, tenantID, req)

    // Inside a transaction that may still roll back (checkout, PJ-31): queue durable work with
    // this request, so it shares the transaction, and hold the inline calls until it commits
    // (`emitDeferredOrderEvents`). A rolled-back write then leaves nothing outside the database.
    const deferred = req.context?.[ORDER_EVENTS_DEFER_CONTEXT]
    if (Array.isArray(deferred)) {
      const batch = deferred as DeferredOrderEvent[]
      const firstForOrder = !batch.some((event) => String(event.orderID) === String(doc.id))
      batch.push({ from, kind: operation === 'create' ? 'created' : 'statusChanged', orderID: doc.id, status, tenantID })
      if (firstForOrder) {
        for (const adapter of forTenant(registry, registry.invoiceSync, settings)) {
          // Not caught: if the outbox write fails, the order write must fail with it.
          await adapter.queue?.({ orderID: doc.id, payload: req.payload, req, status, tenantID })
        }
      }
      return doc
    }
    const errors = await emitOrderEvent(
      registry,
      operation === 'create' ? 'created' : 'statusChanged',
      { orderID: doc.id, payload: req.payload, req, status, tenantID, ...(from === null ? {} : { from }) },
      settings,
    )

    for (const error of errors) req.payload.logger.error({ err: error }, 'payload-jobs: invoice sync adapter failed')

    return doc
  }
