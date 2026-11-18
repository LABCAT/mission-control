import type { Config, Plugin } from 'payload'

import { XERO_SETTINGS_SLUG, XeroSettings } from './xero-settings'

export * from './crypto'
export * from './xero-settings'

export type PayloadXeroOptions = {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
}

/**
 * Xero invoicing for Mission Control. This skeleton adds the `xero-settings` collection.
 *
 * Register `xero-settings` with the multi-tenant plugin too (`collections: { 'xero-settings': {} }`)
 * so it gets the `tenant` field and tenant-scoped access. OAuth and invoicing arrive in PJ-55+.
 */
export const payloadXero =
  (options: PayloadXeroOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    if (incoming.collections?.some((collection) => collection.slug === XERO_SETTINGS_SLUG)) {
      throw new Error(`payload-xero: a "${XERO_SETTINGS_SLUG}" collection already exists.`)
    }

    return {
      ...incoming,
      collections: [...(incoming.collections ?? []), XeroSettings],
      custom: { ...incoming.custom, payloadXero: { enabled: true } },
    }
  }
