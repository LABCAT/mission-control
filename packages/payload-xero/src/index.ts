import type { Config, Plugin } from 'payload'

import {
  buildXeroInvoicesCollection,
  resolveXeroInvoicing,
  xeroInvoiceSyncTask,
  type XeroInvoicingOptions,
} from './invoice-sync'
import { xeroOAuthEndpoints } from './oauth-endpoints'
import type { XeroOAuthOptions } from './oauth'
import {
  authenticatedAdminAccess,
  buildXeroSettingsCollection,
  DEFAULT_SETTINGS_SLUG,
  DEFAULT_TENANT_FIELD,
  type XeroSettingsOptions,
  type XeroScope,
} from './xero-settings'

export * from './contacts'
export * from './crypto'
export * from './invoice-html'
export * from './invoice-sync'
export * from './invoices'
export * from './oauth'
export * from './oauth-endpoints'
export * from './payment-sync'
export * from './token-store'
export * from './xero-settings'

export type PayloadXeroOptions = XeroSettingsOptions & {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /**
   * Invoice sync (PJ-57): an adapter that maps your documents to invoices. Adds the
   * `xero-invoices` collection and the retry task. Left out: no invoicing.
   */
  invoicing?: XeroInvoicingOptions
  /**
   * Credentials for the `/api/xero/connect` and `/api/xero/callback` endpoints (PJ-55).
   * Anything left out falls back to the `XERO_*` env vars. Pass `false` to leave the
   * endpoints out entirely.
   */
  oauth?: false | XeroOAuthOptions
  /** Where the endpoints live. Defaults: `/xero/connect`, `/xero/callback`, `/xero/refresh`. */
  oauthPaths?: { callbackPath?: string; connectPath?: string; refreshPath?: string }
}

export type PayloadXeroCustom = {
  enabled: true
  invoicesSlug: null | string
  oauthEndpoints: boolean
  scope: XeroScope
  settingsSlug: string
  /** The field a tenant-scoped row carries its tenant in. */
  tenantField: string
}

/**
 * Xero invoicing for Payload: the settings collection, encrypted token storage, and the OAuth
 * connect/callback endpoints. The plugin knows nothing about your content model.
 *
 * With `scope: 'tenant'`, register the settings slug with your tenancy layer so it gets the
 * tenant field and tenant-scoped access (see the README).
 */
export const payloadXero =
  (options: PayloadXeroOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const slug = options.settingsSlug ?? DEFAULT_SETTINGS_SLUG
    const scope = options.scope ?? 'global'

    if (incoming.collections?.some((collection) => collection.slug === slug)) {
      throw new Error(`payload-xero: a "${slug}" collection already exists.`)
    }

    const invoicing = options.invoicing
      ? resolveXeroInvoicing({
          invoicing: options.invoicing,
          oauth: options.oauth,
          scope,
          settingsSlug: slug,
          ...(options.tenantField ? { tenantField: options.tenantField } : {}),
        })
      : null
    if (invoicing && incoming.collections?.some((collection) => collection.slug === invoicing.invoicesSlug)) {
      throw new Error(`payload-xero: a "${invoicing.invoicesSlug}" collection already exists.`)
    }

    const custom: PayloadXeroCustom = {
      enabled: true,
      invoicesSlug: invoicing?.invoicesSlug ?? null,
      oauthEndpoints: options.oauth !== false,
      scope,
      settingsSlug: slug,
      tenantField: options.tenantField ?? DEFAULT_TENANT_FIELD,
    }

    return {
      ...incoming,
      collections: [
        ...(incoming.collections ?? []),
        buildXeroSettingsCollection(options),
        ...(invoicing
          ? [
              buildXeroInvoicesCollection({
                ...(options.group ? { group: options.group } : {}),
                // Whoever may read the settings may read the invoice records.
                read: options.access?.read ?? authenticatedAdminAccess,
                slug: invoicing.invoicesSlug,
              }),
            ]
          : []),
      ],
      jobs: invoicing
        ? { ...incoming.jobs, tasks: [...(incoming.jobs?.tasks ?? []), xeroInvoiceSyncTask(invoicing)] }
        : incoming.jobs,
      // Payload routes `/api/xero/*` to the root endpoints. Nesting them under the settings
      // collection instead would give `/api/xero-settings/xero/connect`.
      endpoints: [
        ...(incoming.endpoints ?? []),
        ...(options.oauth === false
          ? []
          : xeroOAuthEndpoints({
              ...options.oauthPaths,
              oauth: options.oauth ?? {},
              scope,
              settingsSlug: slug,
              ...(options.tenantField ? { tenantField: options.tenantField } : {}),
            })),
      ],
      custom: { ...incoming.custom, payloadXero: custom },
    }
  }
