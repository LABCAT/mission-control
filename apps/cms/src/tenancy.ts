import type { MultiTenantPluginConfig } from '@payloadcms/plugin-multi-tenant/types'

import { denySeekerOnly, isSuperAdmin, tenantRoleOptions } from '@mission-control/payload-jobs'

import { siteKeyAccessOverride } from './site-keys'

// mission-control: the plugin gives every tenant member access to the tenant's documents, so
// seekers (site accounts, PJ-81) are denied here. Staff roles are unchanged.
const tenantContentOverride = denySeekerOnly(siteKeyAccessOverride)

/**
 * Every content collection that belongs to a tenant goes here. The plugin adds the
 * `tenant` field, tenant-scoped access and the tenant selector.
 *
 * `accessResultOverride` lets an anonymous request with a valid site key read its tenant.
 */
export const multiTenantOptions = {
  collections: {
    // mission-control: documents are private to tenant members and not exposed to site keys;
    // seekers (site accounts, PJ-81) are denied.
    documents: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    folders: { accessResultOverride: tenantContentOverride },
    locations: { accessResultOverride: tenantContentOverride },
    media: { accessResultOverride: tenantContentOverride },
    tags: { accessResultOverride: tenantContentOverride },
    // mission-control: coupons are private to tenant members and not readable with a site
    // key; seekers are denied (PJ-22).
    coupons: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    // mission-control: job-board taxonomies (PJ-16). Job tags and areas of focus were
    // removed in PJ-80 (no legacy terms).
    'job-categories': { accessResultOverride: tenantContentOverride },
    'job-types': { accessResultOverride: tenantContentOverride },
    'salary-bands': { accessResultOverride: tenantContentOverride },
    // mission-control: organisations read site keys themselves (approved, page-enabled ones
    // only), so they skip the generic site key override; seekers are denied (PJ-18).
    organisations: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    // mission-control: plans read site keys themselves (active plans only), so they skip the
    // generic site key override; seekers are denied (PJ-21).
    plans: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    // mission-control: add-ons, like plans, read site keys themselves (on-sale only) (PJ-87).
    'add-ons': { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    // mission-control: alert subscribers are personal data (PJ-26). The collection's own access
    // already denies site keys, seekers and anonymous callers, so no override is needed here.
    'alert-subscriptions': {},
    // mission-control: jobs read site keys themselves (published and expired only) (PJ-19).
    jobs: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    // mission-control: content pages and menus (PJ-103). The generic override adds the site
    // key's tenant and, for the draft-enabled pages, published only.
    menus: { accessResultOverride: tenantContentOverride },
    pages: { accessResultOverride: tenantContentOverride },
  },
  tenantsArrayField: {
    rowFields: [
      {
        name: 'role',
        type: 'select',
        required: true,
        options: tenantRoleOptions,
        saveToJWT: true,
      },
    ],
  },
  tenantsSlug: 'tenants',
  userHasAccessToAllTenants: (user) => isSuperAdmin(user),
} satisfies MultiTenantPluginConfig
