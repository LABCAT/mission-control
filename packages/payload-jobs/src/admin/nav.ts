import type { CollectionConfig, Config, GlobalConfig } from 'payload'

import { hasAnyTenantRole, isSuperAdmin, type MissionControlUser } from '../access'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from '../slugs'
import { APPLICATIONS_SLUG } from '../collections/applications'

/**
 * The cut-down admin nav for site managers (PJ-30, S-117).
 *
 * A site manager runs one site, so their menu lists the tenant's job-board content and
 * nothing else. It is an allow-list: a collection added later stays out of their menu until
 * someone decides it belongs. Super admins are untouched, and so is everyone else (employers
 * and seekers never use the admin).
 */

/** Roles that run a site. `editor` stays for older data; the MVP has no separate editor role. */
export const SITE_MANAGER_ROLES = ['tenant-admin', 'editor'] as const

/** The slugs the default menu is built from. Every one comes from the host's options (PJ-80). */
export type SiteManagerNavSlugs = {
  /** The host's upload collection for PDF job descriptions; `null` when it has none. */
  documentsSlug?: null | string
  /** The host's upload collection for logos and covers; `null` when it has none. */
  mediaSlug?: null | string
  /** The plugin's resolved collection slugs. Defaults to `DEFAULT_PAYLOAD_JOBS_SLUGS`. */
  slugs?: PayloadJobsCollectionSlugs
  /** The host's auth collection. */
  usersSlug?: string
}

/**
 * What a site manager sees.
 *
 * The first block is the list this task names. The rest is the tenant content a site manager
 * needs to keep running the site: the location tree and taxonomies behind every job form
 * (S-120), the pages and menus of the site (PJ-103, S-145), and the tenant's people and
 * uploads (S-119). Platform collections (tenants, site keys, alert subscriptions) and the
 * job-board settings global stay super-admin only.
 *
 * Every slug the plugin owns comes from its resolved options (PJ-80), so a host that renames
 * `jobs` to `vacancies` keeps it in a site manager's menu. The host upload collections follow
 * `mediaSlug`/`documentsSlug`/`usersSlug` the same way; `applications` has no slug option yet,
 * and `folders`/`tags` belong to the host's own CMS.
 *
 * It is a superset of the task's list on purpose: S-120 is built and needs the location tree
 * and taxonomies in a site manager's menu, and media/documents are the tenant's own uploads.
 * The host can narrow or widen it through `siteManagerAdmin.collections`. The `job-tags` and
 * `areas-of-focus` taxonomies are gone (PJ-80), so they are not in this list.
 */
export const siteManagerNavCollections = ({
  documentsSlug = 'documents',
  mediaSlug = 'media',
  slugs = DEFAULT_PAYLOAD_JOBS_SLUGS,
  usersSlug = 'users',
}: SiteManagerNavSlugs = {}): string[] => [
  slugs.jobs,
  slugs.organisations,
  slugs.orders,
  APPLICATIONS_SLUG,
  slugs.pages,
  slugs.menus,
  // The site's name, logo, footer, language and header banner (PJ-67).
  slugs.siteSettings,
  slugs.plans,
  slugs.coupons,
  slugs.addOns,
  slugs.locations,
  slugs.jobCategories,
  slugs.jobTypes,
  slugs.salaryBands,
  ...(mediaSlug ? [mediaSlug] : []),
  ...(documentsSlug ? [documentsSlug] : []),
  'folders',
  'tags',
  usersSlug,
]

/** The default menu, under the plugin's default slugs. */
export const SITE_MANAGER_NAV_COLLECTIONS = siteManagerNavCollections()

/**
 * True for a signed-in user who manages a tenant's site but not the platform. Employers and
 * seekers are excluded: they hold no tenant-admin or editor membership.
 */
export const isSiteManager = (user: MissionControlUser | null | undefined): boolean => {
  if (!user || isSuperAdmin(user)) return false

  return hasAnyTenantRole(user, SITE_MANAGER_ROLES)
}

type Hidden = NonNullable<NonNullable<CollectionConfig['admin']>['hidden']>

/**
 * True when the entity's own `admin.hidden` already hides it from this user. A hidden function
 * that throws (an unexpected user shape) is treated as hidden, as Payload does.
 */
const wasHidden = (hidden: Hidden | undefined, user: unknown): boolean => {
  if (typeof hidden !== 'function') return Boolean(hidden)

  try {
    return hidden({ user: user as never })
  } catch {
    return true
  }
}

/**
 * Wrap an entity's own `admin.hidden` so a site manager loses the entry while everybody else
 * keeps whatever the entity already decided.
 */
const hiddenForSiteManagers = (hidden: Hidden | undefined) => (args: { user: unknown }): boolean => {
  if (isSiteManager(args.user as MissionControlUser | null | undefined)) return true

  return wasHidden(hidden, args.user)
}

const trimCollection = (collection: CollectionConfig): CollectionConfig => ({
  ...collection,
  admin: { ...collection.admin, hidden: hiddenForSiteManagers(collection.admin?.hidden) },
})

const trimGlobal = (global: GlobalConfig): GlobalConfig => ({
  ...global,
  admin: { ...global.admin, hidden: hiddenForSiteManagers(global.admin?.hidden) },
})

export type SiteManagerNavOptions = {
  /** Collection slugs a site manager keeps. Defaults to `siteManagerNavCollections(slugs)`. */
  collections?: readonly string[]
  /** Global slugs a site manager keeps. Defaults to none: globals are platform settings. */
  globals?: readonly string[]
} & SiteManagerNavSlugs

/**
 * Apply the trimmed nav. `admin.hidden` is what Payload's sidebar, command palette, dashboard
 * cards and pins all read, so this trims the menu for real rather than only visually.
 * Access control is unchanged: the collections' own access rules still decide what can be read
 * (the tests below show a site manager cannot reach another tenant's documents).
 */
export const withSiteManagerNav = (config: Config, options: SiteManagerNavOptions = {}): Config => {
  const { collections, globals, ...slugOptions } = options
  const keepCollections = new Set<string>(collections ?? siteManagerNavCollections(slugOptions))
  const keepGlobals = new Set<string>(globals ?? [])

  return {
    ...config,
    collections: config.collections?.map((collection) =>
      keepCollections.has(collection.slug) ? collection : trimCollection(collection),
    ),
    globals: config.globals?.map((global) =>
      keepGlobals.has(global.slug) ? global : trimGlobal(global),
    ),
  }
}

/** The collection slugs a site manager's nav leaves visible, for tests and diagnostics. */
export const siteManagerVisibleCollections = (
  config: Config,
  user: MissionControlUser,
): string[] =>
  (config.collections ?? [])
    .filter((collection) => !wasHidden(collection.admin?.hidden, user))
    .map((collection) => collection.slug)
