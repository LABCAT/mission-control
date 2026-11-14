import type { CollectionConfig, Config, GlobalConfig, Plugin } from 'payload'

import { Locations, locationsTenantSlugIndex } from './collections/locations'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './collections/locations'
export * from './email'
export * from './seed/vanuatu'
export * from './site-keys'
export * from './tenancy'

export type TenancyMode = 'multi' | 'single'

export type PayloadJobsFeatures = {
  /** Job applications. The collection is added by a later task. Defaults to true. */
  applications?: boolean
  /** Job alert subscriptions. The collection is added by a later task. Defaults to true. */
  alerts?: boolean
  /** Organisation job credits. Added by a later task. Defaults to true. */
  credits?: boolean
  /** Coupons. Added by a later task. Defaults to true. */
  coupons?: boolean
}

export type PayloadJobsOptions = {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Which job-board collections to enable. All default to true. */
  features?: PayloadJobsFeatures
  /** Slug of the tenant settings global in single-tenant mode. */
  settingsSlug?: string
  /** `multi` requires a tenants collection; `single` uses a job-board settings global. */
  tenancy?: TenancyMode
  /** Slug of the tenants collection in multi-tenant mode. */
  tenantsSlug?: string
}

const resolvedFeatures = (options: PayloadJobsOptions): Required<PayloadJobsFeatures> => ({
  applications: options.features?.applications ?? true,
  alerts: options.features?.alerts ?? true,
  credits: options.features?.credits ?? true,
  coupons: options.features?.coupons ?? true,
})

/** Job-board collections owned by this plugin. Later tasks append to this list. */
const jobBoardCollections = (): CollectionConfig[] => [Locations]

/**
 * Job board plugin for Mission Control. It owns the job-board tenant settings and the
 * job-board collections; later tasks (PJ-16 onwards) add the rest.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const tenancy = options.tenancy ?? 'single'
    const tenantsSlug = options.tenantsSlug ?? 'tenants'
    const features = resolvedFeatures(options)

    let config = incoming

    const added = jobBoardCollections()
    const existingSlugs = new Set((config.collections ?? []).map((collection) => collection.slug))
    const clashes = added.filter((collection) => existingSlugs.has(collection.slug))
    if (clashes.length > 0) {
      throw new Error(
        `payload-jobs: these collections already exist: ${clashes.map((c) => c.slug).join(', ')}`,
      )
    }

    config = { ...config, collections: [...(config.collections ?? []), ...added] }

    if (tenancy === 'multi') {
      const tenants = config.collections?.find((collection) => collection.slug === tenantsSlug)

      if (!tenants) {
        throw new Error(
          `payload-jobs: tenancy "multi" requires a "${tenantsSlug}" collection. ` +
            'Create it first or use tenancy: "single".',
        )
      }

      config = {
        ...config,
        collections: config.collections?.map((collection) => {
          if (collection.slug === tenantsSlug) {
            return { ...collection, fields: [...collection.fields, ...jobBoardTenantFields] }
          }

          if (collection.slug === Locations.slug) {
            return {
              ...collection,
              indexes: [...(collection.indexes ?? []), locationsTenantSlugIndex],
            }
          }

          return collection
        }),
      }
    } else {
      const settingsSlug = options.settingsSlug ?? 'job-board-settings'

      if (config.globals?.some((global) => global.slug === settingsSlug)) {
        throw new Error(`payload-jobs: a "${settingsSlug}" global already exists.`)
      }

      config = {
        ...config,
        globals: [
          ...(config.globals ?? []),
          jobBoardSettingsGlobal(settingsSlug) as GlobalConfig,
        ],
      }
    }

    return {
      ...config,
      custom: {
        ...config.custom,
        payloadJobs: { enabled: true, tenancy, features },
      },
    }
  }
