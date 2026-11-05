import type { Access, CollectionBeforeChangeHook, CollectionConfig, Where } from 'payload'

import {
  authenticatedAccess,
  getUserTenantIDsByRole,
  globalRoleOptions,
  isSuperAdmin,
  type MissionControlUser,
  superAdminAccess,
  superAdminFieldAccess,
} from '@mission-control/payload-jobs'

// mission-control: ordinary users may only update themselves; tenant-admins may update
// users in the tenants where they are tenant-admins. The plugin adds the tenant constraint too.
export const usersUpdateAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return false
  if (isSuperAdmin(user)) return true

  const tenantAdminIDs = getUserTenantIDsByRole(user, ['tenant-admin'])
  if (tenantAdminIDs.length > 0) {
    return {
      'tenants.tenant': {
        in: tenantAdminIDs,
      },
    } as Where
  }

  return {
    id: {
      equals: user.id,
    },
  } as Where
}

// mission-control: a fresh database has no super-admin yet, so the first user must bootstrap it.
export const ensureFirstUserIsSuperAdmin: CollectionBeforeChangeHook = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data

  const { totalDocs } = await req.payload.count({
    collection: 'users',
    overrideAccess: true,
    req,
  })

  if (totalDocs === 0) data.role = 'super-admin'

  return data
}

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  access: {
    create: superAdminAccess,
    delete: superAdminAccess,
    read: authenticatedAccess,
    update: usersUpdateAccess,
  },
  auth: true,
  hooks: {
    beforeChange: [ensureFirstUserIsSuperAdmin],
  },
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
