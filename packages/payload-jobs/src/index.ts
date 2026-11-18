import type { Config, GlobalConfig, Plugin } from 'payload'

import { accountAuthEndpoints, type AccountAuthOptions } from './account-auth'
import { withLegacyPasswords } from './legacy-password'
import { planCollection, PLANS_SLUG } from './plans'
import { TAXONOMY_SLUGS, taxonomyCollections } from './taxonomies'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './account-auth'
export * from './email'
export * from './legacy-password'
export * from './money'
export * from './plans'
export * from './plans-seed'
export * from './pricing'
export * from './rate-limit'
export * from './site-keys'
export * from './taxonomies'
export * from './tenancy'

export type TenancyMode = 'multi' | 'single'

/**
 * Collections this plugin adds that belong to a tenant. In `multi` mode the host must list
 * every one of them in the multi-tenant plugin's `collections`, which adds their `tenant`
 * field; Payload otherwise rejects the config ("Field tenant was not found").
 */
export const PAYLOAD_JOBS_TENANT_COLLECTIONS = [...TAXONOMY_SLUGS, PLANS_SLUG] as const

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
  /**
   * Front-end account auth endpoints for the Astro sites (PJ-81), multi-tenant mode only.
   * The users collection must enable `auth.verify`. Pass `false` to leave them out.
   */
  accountAuth?: AccountAuthOptions | false
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Which job-board collections to enable. All default to true. */
  features?: PayloadJobsFeatures
  /** Slug of the auth collection that gets legacy WordPress password support. Defaults to `users`. */
  usersSlug?: string
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
    const features = resolvedFeatures(options)

    let config = incoming

    // mission-control: imported WordPress users keep their passwords (PJ-34).
    const usersSlug = options.usersSlug ?? 'users'
    config = {
      ...config,
      collections: config.collections?.map((collection) =>
        collection.slug === usersSlug ? withLegacyPasswords(collection) : collection,
      ),
    }

    const settingsSlug = options.settingsSlug ?? 'job-board-settings'

    if (tenancy === 'multi') {
      const tenants = config.collections?.find((collection) => collection.slug === tenantsSlug)

      if (!tenants) {
        throw new Error(
          `payload-jobs: tenancy "multi" requires a "${tenantsSlug}" collection. ` +
            'Create it first or use tenancy: "single".',
        )
      }

      const accountEndpoints = (() => {
        if (options.accountAuth === false) return []

        const accountAuth = { tenantsSlug, ...options.accountAuth }
        const usersSlug = accountAuth.usersSlug ?? 'users'
        const users = config.collections?.find((collection) => collection.slug === usersSlug)
        const verify = typeof users?.auth === 'object' ? users.auth.verify : undefined

        if (!users || !verify) {
          throw new Error(
            `payload-jobs: account auth needs a "${usersSlug}" auth collection with auth.verify ` +
              'enabled. Enable it or pass accountAuth: false.',
          )
        }

        return accountAuthEndpoints(accountAuth)
      })()

      config = {
        ...config,
        collections: config.collections?.map((collection) =>
          collection.slug === tenantsSlug
            ? {
                ...collection,
                // Payload routes /api/tenants/* to the collection's endpoints, not the root's.
                endpoints: [
                  ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
                  ...accountEndpoints,
                ],
                fields: [...collection.fields, ...jobBoardTenantFields],
              }
            : collection,
        ),
      }
    } else {
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

    const existingSlugs = new Set(config.collections?.map((collection) => collection.slug))
    const taxonomies = taxonomyCollections({ tenantScoped: tenancy === 'multi' }).filter(
      (collection) => !existingSlugs.has(collection.slug),
    )
    // Plans are always on: every job board sells listings, even if every plan is free.
    const plans = planCollection({ settingsSlug, tenantScoped: tenancy === 'multi', tenantsSlug })

    return {
      ...config,
      collections: [...(config.collections ?? []), ...taxonomies, plans],
      custom: {
        ...config.custom,
        payloadJobs: { enabled: true, tenancy, features },
      },
    }
  }
