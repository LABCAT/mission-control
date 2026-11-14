import type { Config, GlobalConfig, Plugin } from 'payload'

import { emailTemplatesCollection } from './email-templates'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './email'
export * from './email-template-defaults'
export * from './email-template-seed'
export * from './email-templates'
export * from './site-keys'
export * from './tenancy'

export const EMAIL_TEMPLATES_SLUG = 'email-templates'

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
  /** Slug of the email templates collection. Defaults to `email-templates`. */
  emailTemplatesSlug?: string
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

/**
 * Job board plugin for Mission Control. It owns the job-board tenant settings and the
 * email templates; later tasks (PJ-16 onwards) add the job collections.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const tenancy = options.tenancy ?? 'single'
    const tenantsSlug = options.tenantsSlug ?? 'tenants'
    const emailTemplatesSlug = options.emailTemplatesSlug ?? EMAIL_TEMPLATES_SLUG
    const features = resolvedFeatures(options)

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

    if (!config.collections?.some((collection) => collection.slug === emailTemplatesSlug)) {
      config = {
        ...config,
        collections: [
          ...(config.collections ?? []),
          emailTemplatesCollection({ slug: emailTemplatesSlug, tenantScoped: tenancy === 'multi' }),
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
