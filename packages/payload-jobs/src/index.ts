import type {
  CollectionConfig,
  CollectionSlug,
  Config,
  GlobalConfig,
  GlobalSlug,
  Plugin,
} from 'payload'

import { accountAuthEndpoints, type AccountAuthOptions } from './account-auth'
import {
  ALERT_SUBSCRIPTIONS_SLUG,
  alertSubscriptionCollection,
  removeTenantAlertSubscriptions,
  removeTenantAlertSubscriptionsFor,
} from './alert-subscriptions'
import type { LocationsOptions } from './collections/locations'
import { locationsCollection, locationsTenantSlugIndex } from './collections/locations'
import { organisationsCollection, withOrganisationField } from './collections/organisations'
import { couponCollection, removeTenantCouponsFor, removeTenantCoupons } from './coupons'
import { withLegacyPasswords } from './legacy-password'
import { tenantLocationSettings, type TenantLocationSource } from './location-settings'
import { addOnCollection } from './add-ons'
import { jobsCollection } from './collections/jobs'
import { expireJobPlacementsTask, PLACEMENTS_FIELD } from './placements'
import { planCollection, withPlanRestrictionGuards } from './plans'
import {
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  resolvePayloadJobsSlugs,
  type PayloadJobsCollectionSlugs,
  type PayloadJobsCollectionsOptions,
} from './slugs'
import { taxonomyCollections } from './taxonomies'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'

export * from './access'
export * from './account-auth'
export * from './alert-subscriptions'
export * from './collections/locations'
export * from './collections/organisations'
export * from './coupons'
export * from './email'
export * from './legacy-password'
export * from './location-settings'
export * from './money'
export * from './add-ons'
export * from './collections/jobs'
export * from './job-status'
export * from './add-ons-seed'
export * from './catalog'
export * from './placements'
export * from './plans'
export * from './plans-seed'
export * from './pricing'
export * from './rate-limit'
export * from './seed/vanuatu'
export * from './slugs'
export * from './site-keys'
export * from './tax'
export * from './tax-settings'
export * from './taxonomies'
export * from './tenancy'

export type TenancyMode = 'multi' | 'single'

/**
 * Every collection this plugin adds that belongs to a tenant, with the resolved slugs.
 * In `multi` mode the host must list each one in the multi-tenant plugin's `collections`,
 * which adds their `tenant` field; Payload otherwise rejects the config.
 */
export const payloadJobsTenantCollections = (
  slugs: PayloadJobsCollectionSlugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
): string[] => [
  slugs.locations,
  slugs.organisations,
  slugs.jobCategories,
  slugs.jobTypes,
  slugs.salaryBands,
  slugs.addOns,
  slugs.plans,
  slugs.alertSubscriptions,
  slugs.jobs,
  slugs.coupons,
]

/**
 * The one place the plugin options become slugs, shared by the plugin and the helpers.
 * `jobsSlug` predates the per-collection options and still wins for the jobs collection.
 */
const resolveSlugsFromOptions = (options: PayloadJobsOptions): PayloadJobsCollectionSlugs => {
  const slugs = resolvePayloadJobsSlugs(options.collections ?? {})
  if (options.jobsSlug !== undefined) slugs.jobs = options.jobsSlug

  return slugs
}

/** `jobsTenantCollections` alias, named for the multi-tenant plugin option it fills. */
export const jobsTenantCollections = (options: PayloadJobsOptions = {}): string[] =>
  payloadJobsTenantCollections(resolveSlugsFromOptions(options))

/** Tenant collections under the default slugs. */
export const PAYLOAD_JOBS_TENANT_COLLECTIONS = payloadJobsTenantCollections() as string[]

export type PayloadJobsFeatures = {
  /** Job applications. The collection is added by a later task. Defaults to true. */
  applications?: boolean
  /** Email-only job alert subscriptions (PJ-26). Defaults to true. */
  alerts?: boolean
  /** Organisation job credits. Added by a later task. Defaults to true. */
  credits?: boolean
  /** Coupon codes and their discounts. Defaults to true. */
  coupons?: boolean
}

export type PayloadJobsOptions = {
  /**
   * Front-end account auth endpoints for the Astro sites (PJ-81), multi-tenant mode only.
   * The users collection must enable `auth.verify`. Pass `false` to leave them out.
   */
  accountAuth?: AccountAuthOptions | false
  /**
   * Per-collection overrides: rename any slug and/or override its access. Every internal
   * relationship and query uses the resolved slug, so choosing a slug before your first schema migration needs nothing extra. Renaming one on an installation that already has the tables changes the schema: generate and apply your own app migration for it.
   *
   *   collections: { locations: { slug: 'job-locations' } }
   */
  collections?: PayloadJobsCollectionsOptions
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Which job-board collections to enable. All default to true. */
  features?: PayloadJobsFeatures
  /** Slug of the host's upload collection for PDF job descriptions. Defaults to `documents`. */
  documentsSlug?: null | string
  /** Slug of the host's upload collection for organisation logos and covers. Defaults to `media`. */
  mediaSlug?: null | string
  /** Slug of the auth collection that gets legacy WordPress password support. Defaults to `users`. */
  usersSlug?: string
  /** Slug of the tenant settings global in single-tenant mode. */
  settingsSlug?: string
  /** `multi` requires a tenants collection; `single` uses a job-board settings global. */
  tenancy?: TenancyMode
  /** Slug of the tenants collection in multi-tenant mode. */
  tenantsSlug?: string
  /**
   * Slug of the jobs collection (PJ-19). Kept for compatibility; `collections.jobs.slug`
   * is the newer spelling. When it exists and has the `placements` field
   * (`jobPlacementsField()`), the daily task that expires placements is registered.
   */
  jobsSlug?: string
}

const resolvedFeatures = (options: PayloadJobsOptions): Required<PayloadJobsFeatures> => ({
  applications: options.features?.applications ?? true,
  alerts: options.features?.alerts ?? true,
  credits: options.features?.credits ?? true,
  coupons: options.features?.coupons ?? true,
})

/** Job-board collections owned by this plugin. Later tasks append to this list. */
const jobBoardCollections = (
  tenancy: TenancyMode,
  features: Required<PayloadJobsFeatures>,
  mediaSlug: null | string,
  locationsOptions: LocationsOptions,
  slugs: PayloadJobsCollectionSlugs,
  collections: PayloadJobsCollectionsOptions,
): CollectionConfig[] => [
  locationsCollection({
    ...locationsOptions,
    access: collections.locations?.access,
    requireTenant: tenancy === 'multi',
    slug: slugs.locations,
  }),
  organisationsCollection({
    access: collections.organisations?.access,
    locationsSlug: slugs.locations,
    mediaSlug,
    slug: slugs.organisations,
    tenantScoped: tenancy === 'multi',
  }),
  ...(features.alerts
    ? [
        alertSubscriptionCollection({
          access: collections.alertSubscriptions?.access,
          slugs,
          tenantScoped: tenancy === 'multi',
        }),
      ]
    : []),
]

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
    const collectionOptions = options.collections ?? {}
    const slugs = resolveSlugsFromOptions(options)

    let config = incoming

    // mission-control: imported WordPress users keep their passwords (PJ-34), and employers
    // point at their organisation (PJ-18).
    const usersSlug = options.usersSlug ?? 'users'
    config = {
      ...config,
      collections: config.collections?.map((collection) =>
        collection.slug === usersSlug
          ? withOrganisationField(
              withLegacyPasswords(collection),
              tenancy === 'multi',
              slugs.organisations,
            )
          : collection,
      ),
    }

    const settingsSlug = options.settingsSlug ?? 'job-board-settings'

    // The location tree may be capped per tenant. Read the limit at write time, so an admin's
    // change to the tenant settings takes effect on the next save.
    const locationsOptions: LocationsOptions = {
      limits: async ({ data, req }) => {
        if (tenancy === 'multi') {
          const ref = data.tenant
          const tenantID = ref && typeof ref === 'object' ? ref.id : ref

          if (tenantID === null || tenantID === undefined) return null

          const tenant = await req.payload.findByID({
            collection: tenantsSlug as CollectionSlug,
            depth: 0,
            id: tenantID,
            overrideAccess: true,
            req,
          })

          return tenantLocationSettings(tenant as TenantLocationSource)
        }

        const settings = await req.payload.findGlobal({
          depth: 0,
          overrideAccess: true,
          req,
          slug: settingsSlug as GlobalSlug,
        })

        return tenantLocationSettings(settings as TenantLocationSource)
      },
      requireTenant: tenancy === 'multi',
    }

    // Organisation logos and covers point at the host's upload collection. Without one (a
    // minimal config or a test boot) the images are left out rather than failing the build.
    const hostSlugs = new Set((config.collections ?? []).map((collection) => collection.slug))
    const mediaSlug =
      options.mediaSlug === undefined
        ? hostSlugs.has('media')
          ? 'media'
          : null
        : options.mediaSlug

    const added = jobBoardCollections(tenancy, features, mediaSlug, locationsOptions, slugs, collectionOptions)
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
        collections: config.collections?.map((collection) => {
          if (collection.slug === tenantsSlug) {
            return {
              ...collection,
              // Payload routes /api/tenants/* to the collection's endpoints, not the root's.
              endpoints: [
                ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
                ...accountEndpoints,
              ],
              fields: [...collection.fields, ...jobBoardTenantFields],
              hooks: {
                ...collection.hooks,
                // Deleting a tenant must take its subscribers with it, not detach them.
                // Coupons are removed too: the tenant foreign key would otherwise null them.
                beforeDelete: [
                  ...(collection.hooks?.beforeDelete ?? []),
                  ...(features.alerts
                    ? [
                        slugs.alertSubscriptions === ALERT_SUBSCRIPTIONS_SLUG
                          ? removeTenantAlertSubscriptions
                          : removeTenantAlertSubscriptionsFor(slugs.alertSubscriptions),
                      ]
                    : []),
                  ...(features.coupons
                    ? [slugs.coupons === 'coupons' ? removeTenantCoupons : removeTenantCouponsFor(slugs.coupons)]
                    : []),
                ],
              },
            }
          }

          if (collection.slug === slugs.locations) {
            return {
              ...collection,
              indexes: [...(collection.indexes ?? []), locationsTenantSlugIndex],
            }
          }

          return collection
        }),
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

    const registeredSlugs = new Set(config.collections?.map((collection) => collection.slug))
    // Job types and categories that a plan is restricted to can't be deleted (PJ-21).
    const taxonomies = withPlanRestrictionGuards(
      taxonomyCollections({
        access: {
          jobCategories: collectionOptions.jobCategories?.access,
          jobTypes: collectionOptions.jobTypes?.access,
          salaryBands: collectionOptions.salaryBands?.access,
        },
        slugs,
        tenantScoped: tenancy === 'multi',
      }).filter((collection) => !registeredSlugs.has(collection.slug)),
      {
        jobCategoriesSlug: slugs.jobCategories,
        jobTypesSlug: slugs.jobTypes,
        plansSlug: slugs.plans,
        tenantScoped: tenancy === 'multi',
      },
    )
    const catalogOptions = {
      settingsSlug,
      slugs,
      tenantScoped: tenancy === 'multi',
      tenantsSlug,
    }
    // Plans and add-ons are always on: every job board sells listings, even if all are free.
    const addOns = addOnCollection({
      ...catalogOptions,
      access: collectionOptions.addOns?.access,
    })
    const plans = planCollection({
      ...catalogOptions,
      access: collectionOptions.plans?.access,
    })
    const coupons = features.coupons
      ? [
          couponCollection({
            access: collectionOptions.coupons?.access,
            slug: slugs.coupons,
            tenantScoped: tenancy === 'multi',
          }),
        ]
      : []

    // Expire job placements daily, once there is a jobs collection that has them (PJ-19).
    // Jobs go last: Payload numbers compound index names in collection order, and the
    // existing `tenant_slug_*` indexes of organisations and taxonomies must keep their names.
    const documentsSlug =
      options.documentsSlug === undefined
        ? hostSlugs.has('documents')
          ? 'documents'
          : null
        : options.documentsSlug
    const jobs = jobsCollection({
      access: collectionOptions.jobs?.access,
      documentsSlug,
      richTextDescription: Boolean(config.editor),
      slugs,
      tenantScoped: tenancy === 'multi',
    })

    const jobsWithPlacements = [...(config.collections ?? []), jobs].find(
      (collection) => collection.slug === slugs.jobs,
    )
    const hasPlacements = jobsWithPlacements?.fields.some(
      (field) => 'name' in field && field.name === PLACEMENTS_FIELD,
    )
    const jobsConfig = hasPlacements
      ? {
          ...config.jobs,
          tasks: [...(config.jobs?.tasks ?? []), expireJobPlacementsTask({ jobsSlug: slugs.jobs })],
        }
      : config.jobs

    return {
      ...config,
      // Plans before add-ons: Payload numbers compound index names in collection order, and
      // plans' existing `tenant_key_idx` must keep its name.
      collections: [...(config.collections ?? []), ...taxonomies, plans, addOns, jobs, ...coupons],
      jobs: jobsConfig,
      custom: {
        ...config.custom,
        payloadJobs: { enabled: true, tenancy, features },
      },
    }
  }
