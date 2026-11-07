import type { MultiTenantPluginConfig } from '@payloadcms/plugin-multi-tenant/types'

import { isSuperAdmin, tenantRoleOptions } from '@mission-control/payload-jobs'

/**
 * Every content collection that belongs to a tenant goes here. The plugin adds the
 * `tenant` field, tenant-scoped access and the tenant selector.
 */
export const multiTenantOptions = {
  collections: {
    folders: {},
    media: {},
    tags: {},
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
