import type { Config, GlobalConfig, Plugin } from 'payload'

import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './email'
export * from './tenancy'

export type TenancyMode = 'multi' | 'single'

export type PayloadJobsOptions = {
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Slug of the tenant settings global in single-tenant mode. */
  settingsSlug?: string
  /** `multi` requires a tenants collection; `single` uses a job-board settings global. */
  tenancy?: TenancyMode
  /** Slug of the tenants collection in multi-tenant mode. */
  tenantsSlug?: string
}

/**
 * Job board plugin for Mission Control. It owns the job-board tenant settings; later tasks
 * (PJ-15 onwards) add the job collections.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const tenancy = options.tenancy ?? 'single'
    const tenantsSlug = options.tenantsSlug ?? 'tenants'

    let config = incoming

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
        collections: config.collections?.map((collection) =>
          collection.slug === tenantsSlug
            ? { ...collection, fields: [...collection.fields, ...jobBoardTenantFields] }
            : collection,
        ),
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
        payloadJobs: { enabled: true, tenancy },
      },
    }
  }
