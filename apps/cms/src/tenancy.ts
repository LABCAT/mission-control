import type { MultiTenantPluginConfig } from '@payloadcms/plugin-multi-tenant/types'

import { isSuperAdmin, tenantRoleOptions } from '@mission-control/payload-jobs'

import { siteKeyAccessOverride } from './site-keys'

/**
 * Every content collection that belongs to a tenant goes here. The plugin adds the
 * `tenant` field, tenant-scoped access and the tenant selector.
 *
 * `accessResultOverride` lets an anonymous request with a valid site key read its tenant.
 */
export const multiTenantOptions = {
  collections: {
    documents: {}, // mission-control: private to tenant members; not exposed to site keys
    folders: { accessResultOverride: siteKeyAccessOverride },
    media: { accessResultOverride: siteKeyAccessOverride },
    tags: { accessResultOverride: siteKeyAccessOverride },
    // mission-control: job-board taxonomies (PJ-16).
    'areas-of-focus': { accessResultOverride: siteKeyAccessOverride },
    'job-categories': { accessResultOverride: siteKeyAccessOverride },
    'job-tags': { accessResultOverride: siteKeyAccessOverride },
    'job-types': { accessResultOverride: siteKeyAccessOverride },
    'salary-bands': { accessResultOverride: siteKeyAccessOverride },
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
