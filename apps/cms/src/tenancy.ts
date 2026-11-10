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
    folders: { accessResultOverride: siteKeyAccessOverride },
    media: { accessResultOverride: siteKeyAccessOverride },
    tags: { accessResultOverride: siteKeyAccessOverride },
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
