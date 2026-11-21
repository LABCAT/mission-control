import type { Access, Config, Plugin } from 'payload'

import {
  getPayloadJobsRegistry,
  hasAnyTenantRole,
  isSeekerOnly,
  isSuperAdmin,
  type MissionControlUser,
  type OrderEvent,
} from '@mission-control/payload-jobs'
import {
  DEFAULT_INVOICES_SLUG,
  DEFAULT_SETTINGS_SLUG,
  payloadXero,
  resolveXeroInvoicing,
  queueXeroInvoiceSync,
  syncOrQueueXeroInvoice,
  type PayloadXeroOptions,
} from '@mission-control/payload-xero'

import { orderInvoiceAdapter, XERO_ADD_ON_KEY, type OrderInvoiceAdapterOptions } from './order-invoice'

export * from './order-invoice'
export * from './seed'

/**
 * Xero settings and invoice records are billing data: super-admins, and tenant admins (the
 * tenancy layer narrows them to their own tenants). Seekers never.
 */
export const xeroTenantAdminAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null
  if (!user || isSeekerOnly(user)) return false

  return isSuperAdmin(user) || hasAnyTenantRole(user, ['tenant-admin'])
}

export type PayloadJobsXeroOptions = Omit<OrderInvoiceAdapterOptions, 'registry'> & {
  /** Turn the add-on off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /**
   * payload-xero options (slugs, OAuth credentials, access). `scope` follows payload-jobs'
   * tenancy, and `invoicing` is this add-on's adapter.
   */
  xero?: Omit<PayloadXeroOptions, 'enabled' | 'invoicing' | 'scope'> & {
    invoicesSlug?: string
    queue?: string
    taskSlug?: string
  }
}

/** The slugs to list in the multi-tenant plugin. */
export const xeroTenantCollections = (options: PayloadJobsXeroOptions = {}): string[] => [
  options.xero?.settingsSlug ?? DEFAULT_SETTINGS_SLUG,
  options.xero?.invoicesSlug ?? DEFAULT_INVOICES_SLUG,
]

/**
 * Xero add-on (PJ-57). List it after `payloadJobs()`. It installs payload-xero (settings,
 * OAuth, invoice records, retry task) with the order adapter, registers the `xero` add-on and
 * an invoice-sync adapter: a new order gets its draft invoice, and the invoice is authorised
 * when the order is confirmed. A tenant that switches `xero` off is never invoiced.
 */
export const payloadJobsXero =
  (options: PayloadJobsXeroOptions = {}): Plugin =>
  (incoming: Config) => {
    if (options.enabled === false) return incoming

    const registry = getPayloadJobsRegistry(incoming)
    const { invoicesSlug, queue, taskSlug, ...xero } = options.xero ?? {}
    const scope = registry.context.tenancy === 'multi' ? 'tenant' : 'global'
    const invoicing = {
      adapter: orderInvoiceAdapter({
        registry,
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.reference ? { reference: options.reference } : {}),
      }),
      ...(invoicesSlug ? { invoicesSlug } : {}),
      ...(queue ? { queue } : {}),
      ...(taskSlug ? { taskSlug } : {}),
    }
    const xeroOptions: PayloadXeroOptions = {
      access: {
        create: xeroTenantAdminAccess,
        delete: xeroTenantAdminAccess,
        read: xeroTenantAdminAccess,
        update: xeroTenantAdminAccess,
        ...xero.access,
      },
      group: 'Job board',
      ...xero,
      invoicing,
      scope,
    }
    const config = resolveXeroInvoicing({
      invoicing,
      oauth: xeroOptions.oauth,
      scope,
      ...(xeroOptions.settingsSlug ? { settingsSlug: xeroOptions.settingsSlug } : {}),
      ...(xeroOptions.tenantField ? { tenantField: xeroOptions.tenantField } : {}),
    })

    registry.addOns.register({
      collections: [config.settingsSlug, config.invoicesSlug],
      description: 'Invoices orders in Xero.',
      key: XERO_ADD_ON_KEY,
      label: 'Xero invoicing',
    })

    // Runs inside the order's save, with its request: never throws, queues a retry on failure.
    const sync = async ({ orderID, payload, req }: OrderEvent): Promise<void> => {
      await syncOrQueueXeroInvoice({ config, payload, req, sourceId: orderID })
    }

    registry.invoiceSync.register({
      addOn: XERO_ADD_ON_KEY,
      key: 'xero',
      label: 'Xero',
      onOrderCreated: sync,
      onOrderStatusChanged: sync,
      // Inside checkout's transaction (PJ-31) nothing is sent to Xero: the retry job is queued
      // with the order's request, so it commits or rolls back with the order. Checkout calls the
      // handlers above after the commit; if that never happens, the job invoices the order.
      queue: async ({ orderID, payload, req }: OrderEvent): Promise<void> => {
        await queueXeroInvoiceSync({ config, payload, req, sourceId: orderID })
      },
    })

    return payloadXero(xeroOptions)(incoming)
  }
