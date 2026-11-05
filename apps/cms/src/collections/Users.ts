import type { CollectionConfig } from 'payload'

import {
  authenticatedAccess,
  globalRoleOptions,
  superAdminAccess,
  superAdminFieldAccess,
} from '@mission-control/payload-jobs'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: authenticatedAccess,
  },
  auth: true,
  fields: [
    // mission-control: global role; per-tenant roles live in the plugin's `tenants` array.
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'user',
      options: globalRoleOptions,
      saveToJWT: true,
      access: {
        update: superAdminFieldAccess,
      },
      admin: {
        position: 'sidebar',
      },
    },
    // Email added by default
    {
      name: 'firstName',
      type: 'text',
    },
    {
      name: 'lastName',
      type: 'text',
    },
  ],
  versions: false,
}
