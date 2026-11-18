import type { Config, Plugin } from 'payload'

import { buildXeroSettingsCollection, DEFAULT_SETTINGS_SLUG, type XeroSettingsOptions } from './xero-settings'

export * from './crypto'
export * from './xero-settings'

export type PayloadXeroOptions = XeroSettingsOptions & {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
}

/**
 * Xero invoicing for Payload. This skeleton adds the settings collection; OAuth and
 * invoicing arrive in later releases. The plugin knows nothing about your content model.
 *
 * With `scope: 'tenant'`, register the settings slug with your tenancy layer so it gets the
 * tenant field and tenant-scoped access (see the README).
 */
export const payloadXero =
  (options: PayloadXeroOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const slug = options.settingsSlug ?? DEFAULT_SETTINGS_SLUG

    if (incoming.collections?.some((collection) => collection.slug === slug)) {
      throw new Error(`payload-xero: a "${slug}" collection already exists.`)
    }

    return {
      ...incoming,
      collections: [...(incoming.collections ?? []), buildXeroSettingsCollection(options)],
      custom: {
        ...incoming.custom,
        payloadXero: { enabled: true, scope: options.scope ?? 'global', settingsSlug: slug },
      },
    }
  }
