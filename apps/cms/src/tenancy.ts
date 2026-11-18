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
    'email-templates': {},
    // mission-control: documents are private to tenant members and not exposed to site keys;
    // seekers (site accounts, PJ-81) are denied.
    documents: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
    folders: { accessResultOverride: tenantContentOverride },
    locations: { accessResultOverride: tenantContentOverride },
    media: { accessResultOverride: tenantContentOverride },
    tags: { accessResultOverride: tenantContentOverride },
    // mission-control: job-board taxonomies (PJ-16).
    'areas-of-focus': { accessResultOverride: tenantContentOverride },
    'job-categories': { accessResultOverride: tenantContentOverride },
    'job-tags': { accessResultOverride: tenantContentOverride },
    'job-types': { accessResultOverride: tenantContentOverride },
    'salary-bands': { accessResultOverride: tenantContentOverride },
    // mission-control: plans read site keys themselves (active plans only), so they skip the
    // generic site key override; seekers are denied (PJ-21).
    plans: { accessResultOverride: denySeekerOnly(({ accessResult }) => accessResult) },
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
