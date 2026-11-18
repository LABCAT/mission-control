import type { CollectionSlug, Config, GlobalConfig, Plugin } from 'payload'

import { accountAuthEndpoints, type AccountAuthOptions } from './account-auth'
import { withLegacyPasswords } from './legacy-password'
import { pagesCollection } from './pages'
import { siteSettingsCollection, siteSettingsGlobal } from './site-settings'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './account-auth'
export * from './email'
export * from './legacy-password'
export * from './pages'
export * from './rate-limit'
export * from './seo'
export * from './site-keys'
export * from './site-settings'
export * from './tenancy'
export * from './validation'

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
  /** CMS pages. Defaults to true. */
  pages?: boolean
  /** Per-tenant home page and site chrome. Defaults to true. */
  siteSettings?: boolean
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
  /** Slug of the `media` collection that SEO and hero images reference. Defaults to `media`. */
  mediaSlug?: CollectionSlug
  /** Slug of the pages collection. Defaults to `pages`. */
  pagesSlug?: CollectionSlug
  /** Slug of the auth collection that gets legacy WordPress password support. Defaults to `users`. */
  usersSlug?: string
  /** Slug of the tenant settings global in single-tenant mode. */
  settingsSlug?: string
  /** Slug of the site settings collection (multi) or global (single). Defaults to `site-settings`. */
  siteSettingsSlug?: CollectionSlug
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
  pages: options.features?.pages ?? true,
  siteSettings: options.features?.siteSettings ?? true,
})

/**
 * Job board plugin for Mission Control. It owns the job-board tenant settings and the CMS
 * content collections; later tasks (PJ-16 onwards) add the job collections.
 *
 * In multi-tenant mode `pages` and `site-settings` are ordinary collections that the
 * multi-tenant plugin scopes to a tenant. `site-settings` must be registered with
 * `isGlobal: true` in that plugin's options (`siteSettingsMultiTenantOptions`), which makes
 * the tenant field unique so a tenant has exactly one settings document.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const tenancy = options.tenancy ?? 'single'
    const tenantsSlug = options.tenantsSlug ?? 'tenants'
    const features = resolvedFeatures(options)
    const pagesSlug = options.pagesSlug ?? 'pages'
    const siteSettingsSlug = options.siteSettingsSlug ?? 'site-settings'
    const mediaSlug = options.mediaSlug ?? 'media'

    let config = incoming

    // mission-control: imported WordPress users keep their passwords (PJ-34).
    const usersSlug = options.usersSlug ?? 'users'
    config = {
      ...config,
      collections: config.collections?.map((collection) =>
        collection.slug === usersSlug ? withLegacyPasswords(collection) : collection,
      ),
    }

    if (tenancy === 'multi') {
      const tenants = config.collections?.find((collection) => collection.slug === tenantsSlug)

      if (!tenants) {
        throw new Error(
          `payload-jobs: tenancy "multi" requires a "${tenantsSlug}" collection. ` +
            'Create it first or use tenancy: "single".',
        )
      }

      const contentCollections = [
        ...(features.pages
          ? [pagesCollection({ mediaSlug, slug: pagesSlug, tenantScoped: true })]
          : []),
        ...(features.siteSettings
          ? [siteSettingsCollection({ mediaSlug, slug: siteSettingsSlug })]
          : []),
      ]

      for (const collection of contentCollections) {
        if (config.collections?.some((existing) => existing.slug === collection.slug)) {
          throw new Error(`payload-jobs: a "${collection.slug}" collection already exists.`)
        }
      }

      const accountEndpoints = (() => {
        if (options.accountAuth === false) return []

        const accountAuth = { tenantsSlug, ...options.accountAuth }
        const accountUsersSlug = accountAuth.usersSlug ?? 'users'
        const users = config.collections?.find(
          (collection) => collection.slug === accountUsersSlug,
        )
        const verify = typeof users?.auth === 'object' ? users.auth.verify : undefined

        if (!users || !verify) {
          throw new Error(
            `payload-jobs: account auth needs a "${accountUsersSlug}" auth collection with ` +
              'auth.verify enabled. Enable it or pass accountAuth: false.',
          )
        }

        return accountAuthEndpoints(accountAuth)
      })()

      config = {
        ...config,
        collections: [
          ...(config.collections ?? []).map((collection) =>
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
          ...contentCollections,
        ],
      }
    } else {
      const settingsSlug = options.settingsSlug ?? 'job-board-settings'

      if (config.globals?.some((global) => global.slug === settingsSlug)) {
        throw new Error(`payload-jobs: a "${settingsSlug}" global already exists.`)
      }

      if (config.collections?.some((collection) => collection.slug === pagesSlug)) {
        throw new Error(`payload-jobs: a "${pagesSlug}" collection already exists.`)
      }

      if (config.globals?.some((global) => global.slug === siteSettingsSlug)) {
        throw new Error(`payload-jobs: a "${siteSettingsSlug}" global already exists.`)
      }

      config = {
        ...config,
        collections: [
          ...(config.collections ?? []),
          ...(features.pages
            ? [pagesCollection({ mediaSlug, slug: pagesSlug, tenantScoped: false })]
            : []),
        ],
        globals: [
          ...(config.globals ?? []),
          jobBoardSettingsGlobal(settingsSlug) as GlobalConfig,
          ...(features.siteSettings
            ? [siteSettingsGlobal({ mediaSlug, slug: siteSettingsSlug }) as GlobalConfig]
            : []),
        ],
      }
    }

    return {
      ...config,
      custom: {
        ...config.custom,
        payloadJobs: {
          enabled: true,
          features,
          pagesSlug,
          siteSettingsSlug,
          tenancy,
        },
      },
    }
  }
