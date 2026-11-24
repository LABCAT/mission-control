import type {
  CollectionConfig,
  CollectionSlug,
  Config,
  GlobalConfig,
  GlobalSlug,
  Plugin,
} from 'payload'

import { accountAuthEndpoints, type AccountAuthOptions } from './account-auth'
import { withViewAs } from './view-as'
import { DASHBOARD_COMPONENT_PATH, type SiteManagerAdminOptions } from './admin'
import { accountCheckoutEndpoints, type PurchaseRightsCheck } from './checkout'
import type { LocationsOptions } from './collections/locations'
import { locationsCollection, locationsTenantSlugIndex } from './collections/locations'
import { organisationsCollection, withOrganisationField } from './collections/organisations'
import {
  creditLedgerCollection,
  organisationHistoryEndpoint,
  refundCreditOnCancel,
  refuseDeleteWhileInCreditLedger,
} from './credits'
import { couponCollection, removeTenantCouponsFor, removeTenantCoupons } from './coupons'
import { withLegacyPasswords } from './legacy-password'
import { tenantLocationSettings, type TenantLocationSource } from './location-settings'
import { addOnCollection } from './add-ons'
import {
  APPLICATION_FILES_SLUG,
  APPLICATIONS_SLUG,
  applicationFilesCollection,
  applicationsCollection,
  blockDeleteWhileReferencedByApplications,
} from './collections/applications'
import { jobsCollection } from './collections/jobs'
import { menusCollection, removeTenantMenus } from './collections/menus'
import { pagesCollection } from './collections/pages'
import {
  removeTenantSiteSettings,
  seedTenantSiteSettings,
  siteSettingsCollection,
} from './collections/site-settings'
import {
  isOrganisationOwnerByRole,
  orderCollection,
  refuseDeleteWhileOrdered,
  type OrganisationOwnerCheck,
} from './orders'
import { resolvePaymentProviders, type PaymentProviderDefinition } from './payment-providers'
import { expireJobPlacementsTask, PLACEMENTS_FIELD } from './placements'
import { withPersonalDataRemoval } from './anonymise-user'
import { seedTenantLegalPages } from './legal-pages'
import { planCollection, withPlanRestrictionGuards } from './plans'
import {
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  resolvePayloadJobsSlugs,
  type PayloadJobsCollectionSlugs,
  type PayloadJobsCollectionsOptions,
} from './slugs'
import { slugRulesFor } from './slug-rules'
import { removeTenantPages, seedTenantSystemPages } from './system-pages'
import { taxonomyCollections } from './taxonomies'
import { jobLifecycleHook, orderEventHook } from './plug-points/gate'
import { createPayloadJobsRegistry } from './plug-points/payload-jobs-registry'
import { jobBoardAddOnsField } from './plug-points/tenant-field'
import { jobBoardSettingsGlobal, jobBoardTenantFields } from './tenancy'
import { withSiteManagerNav } from './admin/nav'

export * from './access'
export * from './admin'
export * from './account-auth'
export * from './anonymise-user'
export * from './audit-log'
export * from './checkout'
export * from './view-as'
export * from './collections/locations'
export * from './collections/menus'
export * from './collections/organisations'
export * from './collections/pages'
export * from './collections/site-settings'
export * from './coupons'
export * from './credits'
export * from './email'
export * from './legacy-password'
export * from './location-settings'
export * from './money'
export * from './plug-points'
export * from './orders'
export * from './payment-providers'
export * from './slug-rules'
export * from './add-ons'
export * from './collections/jobs'
export * from './collections/applications'
export * from './job-status'
export * from './legal-pages'
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
export * from './system-pages'
export * from './tax'
export * from './tax-settings'
export * from './taxonomies'
export * from './tenancy'

export type TenancyMode = 'multi' | 'single'

/** Add a delete guard so a document that orders point at is kept (PJ-23). */
const withOrderDeleteGuard = (
  collection: CollectionConfig,
  field: 'jobs' | 'organisation',
  noun: string,
  ordersSlug: string,
): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    beforeDelete: [
      refuseDeleteWhileOrdered({ field, noun, ordersSlug }),
      ...(collection.hooks?.beforeDelete ?? []),
    ],
  },
})

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
  slugs.pages,
  slugs.menus,
  slugs.jobCategories,
  slugs.jobTypes,
  slugs.salaryBands,
  slugs.addOns,
  slugs.plans,
  slugs.jobs,
  slugs.coupons,
  APPLICATION_FILES_SLUG,
  APPLICATIONS_SLUG,
  slugs.orders,
  slugs.creditLedger,
  slugs.siteSettings,
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
  /** Applications and their private CV files (PJ-25). Defaults to true. */
  applications?: boolean
  /**
   * Organisation job credits: the append-only credit ledger, the History endpoint and the
   * refund of a job cancelled before publishing (PJ-24). Defaults to true.
   */
  credits?: boolean
  /** Coupon codes and their discounts. Defaults to true. */
  coupons?: boolean
  /** Content pages, the system pages seeded per site, and menus (PJ-103). Defaults to true. */
  pages?: boolean
}

/** Orders (PJ-23). Always on: every job board sells listings, even if all are free. */
export type PayloadJobsOrdersOptions = {
  /**
   * Who owns an organisation, so they can answer a member's purchase request. Defaults to
   * `isOrganisationOwnerByRole`: the user's `organisationRole` is `owner` (PJ-62).
   */
  isOrganisationOwner?: OrganisationOwnerCheck
  /**
   * Payment providers beyond core's `invoice`, e.g. `{ key: 'stripe', label: 'Card' }` from a
   * payment add-on. An order may only name a registered provider.
   */
  paymentProviders?: PaymentProviderDefinition[]
  /**
   * What a member may spend for their organisation at checkout (PJ-31). Defaults to
   * `defaultPurchaseRights`: owners and site managers anything; members use credits unless
   * `useCredits` is false and buy only when `canBuy` is true (the per-member switches of PJ-29).
   */
  purchaseRights?: PurchaseRightsCheck
}

export type PayloadJobsOptions = {
  /**
   * Front-end account auth endpoints for the Astro sites (PJ-81), multi-tenant mode only.
   * The users collection must enable `auth.verify`. Pass `false` to leave them out.
   */
  accountAuth?: AccountAuthOptions | false
  /**
   * Super admins can view the site as a site account (PJ-119): adds the `audit-log` collection
   * and the guard rails. Needs multi-tenant mode and account auth. Defaults to on.
   */
  viewAsUser?: boolean
  /**
   * Per-collection overrides: rename any slug and/or override its access. Every internal
   * relationship and query uses the resolved slug, so choosing a slug before your first schema migration needs nothing extra. Renaming one on an installation that already has the tables changes the schema: generate and apply your own app migration for it.
   *
   *   collections: { locations: { slug: 'job-locations' } }
   */
  collections?: PayloadJobsCollectionsOptions
  /**
   * Words that no job category, location or job type slug may be, because they would collide
   * with a route on the site. Defaults to `DEFAULT_RESERVED_SLUGS`.
   */
  reservedSlugs?: readonly string[]
  /** Turn the plugin off without removing it from the config. Defaults to true. */
  enabled?: boolean
  /** Which job-board collections to enable. All default to true. */
  features?: PayloadJobsFeatures
  /** Orders: organisation owners and payment providers (PJ-23). */
  orders?: PayloadJobsOrdersOptions
  /** Slug of the host's upload collection for PDF job descriptions. Defaults to `documents`. */
  documentsSlug?: null | string
  /** Slug of the host's upload collection for organisation logos and covers. Defaults to `media`. */
  mediaSlug?: null | string
  /** Slug of the auth collection that gets legacy WordPress password support. Defaults to `users`. */
  usersSlug?: string
  /**
   * Slug of the job alerts collection, when that add-on is installed. Personal data removal
   * (PJ-89) deletes the removed person's alert subscriptions. Defaults to `alert-subscriptions`.
   */
  alertSubscriptionsSlug?: string
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
  /**
   * The tenant-scoped admin for site managers (PJ-30): a cut-down nav and a dashboard of
   * pending jobs and recent orders. Defaults to on. Pass `false` for the stock admin, or an
   * object to keep extra collections in the site manager's menu (e.g. `media`).
   */
  siteManagerAdmin?: boolean | SiteManagerAdminOptions
}

const withApplicationDeleteGuard = (
  collection: CollectionConfig,
  field: 'job' | 'organisation',
  label: string,
): CollectionConfig => ({
  ...collection,
  hooks: {
    ...collection.hooks,
    beforeDelete: [
      ...(collection.hooks?.beforeDelete ?? []),
      blockDeleteWhileReferencedByApplications({ fields: [field], label }),
      // A CV is uploaded before its application exists, so organisations also guard their files.
      ...(field === 'organisation'
        ? [
            blockDeleteWhileReferencedByApplications({
              collection: APPLICATION_FILES_SLUG,
              fields: ['organisation'],
              label,
            }),
          ]
        : []),
    ],
  },
})

/**
 * Keep the credit history: refuse to delete a document credit rows point at (PJ-24), and add
 * any extra endpoints or hooks the collection needs for credits.
 */
const withCreditLedger = (
  collection: CollectionConfig,
  field: 'job' | 'order' | 'organisation',
  noun: string,
  ledgerSlug: string,
  extra: { afterChange?: NonNullable<CollectionConfig['hooks']>['afterChange']; endpoints?: CollectionConfig['endpoints'] } = {},
): CollectionConfig => ({
  ...collection,
  endpoints: [
    ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
    ...(Array.isArray(extra.endpoints) ? extra.endpoints : []),
  ],
  hooks: {
    ...collection.hooks,
    afterChange: [...(collection.hooks?.afterChange ?? []), ...(extra.afterChange ?? [])],
    beforeDelete: [
      ...(collection.hooks?.beforeDelete ?? []),
      refuseDeleteWhileInCreditLedger({ field, ledgerSlug, noun }),
    ],
  },
})

const resolvedFeatures = (options: PayloadJobsOptions): Required<PayloadJobsFeatures> => ({
  applications: options.features?.applications ?? true,
  credits: options.features?.credits ?? true,
  coupons: options.features?.coupons ?? true,
  pages: options.features?.pages ?? true,
})

/** Job-board collections owned by this plugin. Later tasks append to this list. */
const jobBoardCollections = (
  tenancy: TenancyMode,
  features: Required<PayloadJobsFeatures>,
  mediaSlug: null | string,
  locationsOptions: LocationsOptions,
  slugs: PayloadJobsCollectionSlugs,
  collections: PayloadJobsCollectionsOptions,
  blockSlugs: readonly string[],
): CollectionConfig[] => [
  locationsCollection({
    ...locationsOptions,
    access: collections.locations?.access,
    requireTenant: tenancy === 'multi',
    slug: slugs.locations,
  }),
  withOrderDeleteGuard(
    organisationsCollection({
      access: collections.organisations?.access,
      locationsSlug: slugs.locations,
      mediaSlug,
      slug: slugs.organisations,
      tenantScoped: tenancy === 'multi',
    }),
    'organisation',
    'organisation',
    slugs.orders,
  ),
  ...(features.pages
    ? [
        pagesCollection({
          access: collections.pages?.access,
          blockSlugs,
          mediaSlug,
          slug: slugs.pages,
          tenantScoped: tenancy === 'multi',
        }),
        menusCollection({
          access: collections.menus?.access,
          pagesSlug: slugs.pages,
          slug: slugs.menus,
          tenantScoped: tenancy === 'multi',
        }),
        siteSettingsCollection({
          access: collections.siteSettings?.access,
          bannerBlockSlugs: blockSlugs.includes('banner') ? ['banner'] : [],
          mediaSlug,
          slug: slugs.siteSettings,
          tenantScoped: tenancy === 'multi',
        }),
      ]
    : []),
]

/**
 * Block slugs the host registered in `config.blocks` (rocketship-payload, PJ-84). The pages
 * layout offers exactly those, so the plugin needs no dependency on the block library and a
 * host with no blocks still gets a page whose layout is an empty list.
 */
const registeredBlockSlugs = (config: Config): string[] =>
  (config.blocks ?? [])
    .map((block) => (typeof block === 'string' ? null : block.slug))
    .filter((slug): slug is string => typeof slug === 'string')

/**
 * Job board plugin for Mission Control. It owns the job-board tenant settings and the
 * job-board collections; later tasks (PJ-16 onwards) add the rest.
 */
const jobBoardPlugin =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    if (options.enabled === false) return incoming

    const tenancy = options.tenancy ?? 'single'
    const tenantsSlug = options.tenantsSlug ?? 'tenants'
    const features = resolvedFeatures(options)
    const collectionOptions = options.collections ?? {}
    const slugs = resolveSlugsFromOptions(options)

    // The registry add-on plugins register their plug points on (PJ-115).
    const registry = createPayloadJobsRegistry({ settingsSlug: options.settingsSlug ?? 'job-board-settings', slugs, tenancy, tenantsSlug })
    const addOnsField = jobBoardAddOnsField(registry)

    let config = incoming

    // mission-control: imported WordPress users keep their passwords (PJ-34), and employers
    // point at their organisation (PJ-18).
    const usersSlug = options.usersSlug ?? 'users'
    config = {
      ...config,
      collections: config.collections?.map((collection) =>
        collection.slug === usersSlug
          ? withPersonalDataRemoval(
              withOrganisationField(
                withLegacyPasswords(collection),
                tenancy === 'multi',
                slugs.organisations,
              ),
              {
                alertSubscriptionsSlug: options.alertSubscriptionsSlug ?? 'alert-subscriptions',
                applicationsSlug: APPLICATIONS_SLUG,
                filesSlug: APPLICATION_FILES_SLUG,
                usersSlug,
              },
            )
          : collection,
      ),
    }

    const settingsSlug = options.settingsSlug ?? 'job-board-settings'

    // The location tree may be capped per tenant. Read the limit at write time, so an admin's
    // change to the tenant settings takes effect on the next save.
    const locationsOptions: LocationsOptions = {
      slugRules: slugRulesFor(slugs, options.reservedSlugs),
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

    const added = jobBoardCollections(
      tenancy,
      features,
      mediaSlug,
      locationsOptions,
      slugs,
      collectionOptions,
      registeredBlockSlugs(config),
    )
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

        return [
          ...accountAuthEndpoints(accountAuth),
          // Checkout for the /account dashboard (PJ-31), on the same site key + token contract.
          ...accountCheckoutEndpoints({
            couponsEnabled: features.coupons,
            creditsEnabled: features.credits,
            isOrganisationOwner: options.orders?.isOrganisationOwner ?? isOrganisationOwnerByRole,
            purchaseRights: options.orders?.purchaseRights,
            rateLimiter: accountAuth.rateLimiter,
            registry,
            settingsSlug,
            slugs,
            tenantScoped: true,
            tenantsSlug,
            usersSlug: accountUsersSlug,
          }),
        ]
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
              fields: [...collection.fields, ...jobBoardTenantFields, addOnsField],
              hooks: {
                ...collection.hooks,
                ...(features.pages
                  ? {
                      // A new site starts with its four system pages (PJ-103).
                      afterChange: [
                        ...(collection.hooks?.afterChange ?? []),
                        seedTenantSystemPages({
                          collectionSlug: slugs.pages,
                          tenantScoped: tenancy === 'multi',
                        }),
                        // And its settings document (PJ-67).
                        seedTenantSiteSettings({
                          collectionSlug: slugs.siteSettings,
                          tenantScoped: tenancy === 'multi',
                        }),
                        // And its privacy policy and terms as drafts (PJ-89).
                        seedTenantLegalPages({
                          blockSlugs: registeredBlockSlugs(config),
                          collectionSlug: slugs.pages,
                          tenantScoped: tenancy === 'multi',
                        }),
                      ],
                    }
                  : {}),
                // Coupons are removed with the tenant: the tenant foreign key would otherwise
                // null them. Add-ons clean up their own data the same way (PJ-115).
                beforeDelete: [
                  ...(collection.hooks?.beforeDelete ?? []),
                  // Orders are kept for accounting: a tenant that has any can't be deleted. This
                  // runs before the plugin removes anything; the delete's transaction rolls back
                  // whatever the host's own hooks did.
                  refuseDeleteWhileOrdered({ field: 'tenant', noun: 'tenant', ordersSlug: slugs.orders }),
                  // Credit history is kept too (PJ-24).
                  ...(features.credits
                    ? [refuseDeleteWhileInCreditLedger({ field: 'tenant', ledgerSlug: slugs.creditLedger, noun: 'tenant' })]
                    : []),
                  // A deleted site takes its pages and menus with it.
                  ...(features.pages
                    ? [
                        removeTenantPages({ collectionSlug: slugs.pages }),
                        removeTenantMenus({ collectionSlug: slugs.menus }),
                        removeTenantSiteSettings({ collectionSlug: slugs.siteSettings }),
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
          jobBoardSettingsGlobal(settingsSlug, [addOnsField]) as GlobalConfig,
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
        reservedSlugs: options.reservedSlugs,
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
    const baseJobs = withOrderDeleteGuard(jobsCollection({
      access: collectionOptions.jobs?.access,
      documentsSlug,
      richTextDescription: Boolean(config.editor),
      slugs,
      tenantScoped: tenancy === 'multi',
      withOrder: true,
    }), 'jobs', 'job', slugs.orders)

    // Orders go last, after coupons, so the existing compound index names keep their numbers.
    const paymentProviders = resolvePaymentProviders(options.orders?.paymentProviders ?? [])
    const baseOrders = orderCollection({
      access: collectionOptions.orders?.access,
      couponsEnabled: features.coupons,
      isOrganisationOwner: options.orders?.isOrganisationOwner ?? isOrganisationOwnerByRole,
      paymentProviders,
      slugs,
      tenantScoped: tenancy === 'multi',
      usersSlug,
    })
    // Add-ons hear about jobs being published, expired or cancelled (PJ-115).
    const lifecycleJobs: CollectionConfig = {
      ...baseJobs,
      hooks: {
        ...baseJobs.hooks,
        afterChange: [...(baseJobs.hooks?.afterChange ?? []), jobLifecycleHook(registry, slugs.jobs)],
      },
    }
    // Credits (PJ-24): a job cancelled before publishing gets its credit back, and documents the
    // ledger points at are kept.
    const jobs = features.credits
      ? withCreditLedger(lifecycleJobs, 'job', 'job', slugs.creditLedger, {
          afterChange: [refundCreditOnCancel({ slug: slugs.creditLedger })],
        })
      : lifecycleJobs
    // Invoice-sync adapters hear about new orders and status changes (PJ-115, PJ-57).
    const eventOrders: CollectionConfig = {
      ...baseOrders,
      hooks: {
        ...baseOrders.hooks,
        afterChange: [...(baseOrders.hooks?.afterChange ?? []), orderEventHook(registry)],
      },
    }
    const orders = features.credits ? withCreditLedger(eventOrders, 'order', 'order', slugs.creditLedger) : eventOrders
    const creditLedger = features.credits
      ? [creditLedgerCollection({ access: collectionOptions.creditLedger?.access, slugs, tenantScoped: tenancy === 'multi', usersSlug })]
      : []

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

    const jobBoardConfig: Config = {
      ...config,
      // Plans before add-ons: Payload numbers compound index names in collection order, and
      // plans' existing `tenant_key_idx` must keep its name.
      // Applications and their files go after jobs: they relate to it, and the compound
      // index names of the collections before them must not shift.
      collections: [
        ...(config.collections ?? []).map((collection) => {
          if (collection.slug !== slugs.organisations) return collection
          const guarded = features.applications
            ? withApplicationDeleteGuard(collection, 'organisation', 'organisation')
            : collection
          // The History tab's data (PJ-24): orders, credit movements and job events.
          return features.credits
            ? withCreditLedger(guarded, 'organisation', 'organisation', slugs.creditLedger, {
                endpoints: [organisationHistoryEndpoint({ slugs, tenantScoped: tenancy === 'multi' })],
              })
            : guarded
        }),
        ...taxonomies,
        plans,
        addOns,
        features.applications ? withApplicationDeleteGuard(jobs, 'job', 'job') : jobs,
        ...coupons,
        ...(features.applications
          ? [
              applicationFilesCollection({
                applicantsSlug: usersSlug,
                organisationsSlug: slugs.organisations,
                tenantScoped: tenancy === 'multi',
              }),
              applicationsCollection({
                applicantsSlug: usersSlug,
                jobsSlug: slugs.jobs,
                organisationsSlug: slugs.organisations,
                tenantScoped: tenancy === 'multi',
              }),
            ]
          : []),
        // Orders go last (PJ-23), so no existing compound index name shifts.
        orders,
        // The credit ledger after orders (PJ-24), for the same reason.
        ...creditLedger,
      ],
      jobs: jobsConfig,
      custom: {
        ...config.custom,
        payloadJobs: {
          enabled: true,
          features,
          registry,
          paymentProviders: paymentProviders.map((provider) => provider.key),
          // The dashboard and other admin code read the slugs back from here (PJ-80). Every
          // resolved slug travels, so renamed collections (orders, PJ-23) are found.
          slugs: { ...slugs, tenants: tenantsSlug },
          tenancy,
        },
      },
    }

    if (options.siteManagerAdmin === false) return jobBoardConfig

    // Site managers get a cut-down menu and a dashboard of their own tenant (PJ-30, S-117).
    // Multi-tenant only: single mode has no site managers to scope.
    if (tenancy !== 'multi') return jobBoardConfig

    const siteManagerAdmin = options.siteManagerAdmin === true ? {} : (options.siteManagerAdmin ?? {})

    return {
      // The default menu is built from the resolved slugs, so a renamed collection stays in
      // a site manager's menu (PJ-80). A host allow-list replaces it, as before.
      ...withSiteManagerNav(jobBoardConfig, {
        documentsSlug,
        mediaSlug,
        slugs,
        usersSlug,
        ...siteManagerAdmin,
      }),
      admin: {
        ...jobBoardConfig.admin,
        components: {
          ...jobBoardConfig.admin?.components,
          beforeDashboard: [
            ...(jobBoardConfig.admin?.components?.beforeDashboard ?? []),
            { path: DASHBOARD_COMPONENT_PATH },
          ],
        },
      },
    }
  }

/**
 * Job board plugin for Mission Control (see `jobBoardPlugin`), plus "view as user" (PJ-119) in
 * multi-tenant mode: the audit log, the view-as auth strategy and the guard rails. Applied last
 * so it sees every collection the job board added. Pass `viewAsUser: false` to leave it out.
 */
export const payloadJobs =
  (options: PayloadJobsOptions = {}): Plugin =>
  (incoming: Config): Config => {
    // Synchronous on purpose: a bad config throws here, not as a rejected promise.
    const config = jobBoardPlugin(options)(incoming) as Config

    if (options.enabled === false || options.viewAsUser === false) return config
    if ((options.tenancy ?? 'single') !== 'multi' || options.accountAuth === false) return config

    return withViewAs(config, {
      accountRoles: options.accountAuth?.accountRoles,
      ordersSlug: resolveSlugsFromOptions(options).orders,
      tenantsSlug: options.tenantsSlug ?? 'tenants',
      usersSlug: options.accountAuth?.usersSlug ?? options.usersSlug ?? 'users',
    })
  }
