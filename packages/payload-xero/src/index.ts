import type { Config, Plugin } from 'payload'

import { xeroOAuthEndpoints } from './oauth-endpoints'
import type { XeroOAuthOptions } from './oauth'
import {
  buildXeroSettingsCollection,
  DEFAULT_SETTINGS_SLUG,
  type XeroSettingsOptions,
  type XeroScope,
} from './xero-settings'

export * from './crypto'
export * from './oauth'
export * from './oauth-endpoints'
export * from './token-store'
export * from './xero-settings'

export type PayloadXeroOptions = XeroSettingsOptions & {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
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
  oauthEndpoints: boolean
  scope: XeroScope
  settingsSlug: string
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

    const custom: PayloadXeroCustom = {
      enabled: true,
      oauthEndpoints: options.oauth !== false,
      scope,
      settingsSlug: slug,
    }

    return {
      ...incoming,
      collections: [...(incoming.collections ?? []), buildXeroSettingsCollection(options)],
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
