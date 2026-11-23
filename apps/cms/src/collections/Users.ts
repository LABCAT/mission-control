import { Forbidden, type Access, type CollectionBeforeChangeHook, type CollectionConfig, type Where } from 'payload'

import {
  ACCOUNT_SIGNUP_CONTEXT,
  accountUserHooks,
  adminPanelAccess,
  getUserTenantIDsByRole,
  globalRoleOptions,
  isSeekerOnly,
  isSuperAdmin,
  PERSONAL_DATA_REMOVAL_CONTEXT,
  type MissionControlUser,
  superAdminAccess,
  superAdminFieldAccess,
} from '@mission-control/payload-jobs'

// mission-control: ordinary users may only update themselves; tenant-admins may update users
// in the tenants where they are tenant-admins, but never a super-admin, even a super-admin who
// is a member of those tenants. The plugin adds its own tenant constraint on top.
export const usersUpdateAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return false
  if (isSuperAdmin(user)) return true

  const tenantAdminIDs = getUserTenantIDsByRole(user, ['tenant-admin'])
  if (tenantAdminIDs.length > 0) {
    return {
      and: [
        { 'tenants.tenant': { in: tenantAdminIDs } },
        { role: { not_equals: 'super-admin' } },
      ],
    } as Where
  }

  return {
    id: {
      equals: user.id,
    },
  } as Where
}

// mission-control: seekers (site accounts) may only read their own user. Other roles keep the
// tenant-scoped read access the multi-tenant plugin adds.
export const usersReadAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return false
  if (isSeekerOnly(user)) return { id: { equals: user.id } } as Where

  return true
}

// mission-control: a tenant-admin may edit another member's profile, but not their login.
export const preventTenantAdminCredentialChanges: CollectionBeforeChangeHook = ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  if (operation !== 'update' || !originalDoc) return data
  // mission-control: personal data removal (PJ-89) replaces the email and password after its own
  // permission check; only server code sets this context.
  if (req.context?.[PERSONAL_DATA_REMOVAL_CONTEXT]) return data

  const actor = req.user as MissionControlUser | null | undefined
  if (!actor || isSuperAdmin(actor) || String(actor.id) === String(originalDoc.id)) return data

  if (data.email !== undefined && data.email !== originalDoc.email) throw new Forbidden(req.t)
  if (data.password !== undefined) throw new Forbidden(req.t)

  return data
}

// mission-control: a fresh database has no super-admin yet, so the first user must bootstrap it.
export const ensureFirstUserIsSuperAdmin: CollectionBeforeChangeHook = async ({
  data,
  operation,
  req,
}) => {
  if (operation !== 'create') return data
  // Site sign-ups are never the bootstrap user, even on an empty database.
  if (req.context?.[ACCOUNT_SIGNUP_CONTEXT]) return data

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
    admin: adminPanelAccess, // mission-control: seekers use the site dashboards, not the admin
    create: superAdminAccess,
    // mission-control: super-admin only, so a tenant-admin can never delete a super-admin.
    delete: superAdminAccess,
    read: usersReadAccess,
    update: usersUpdateAccess,
  },
  // mission-control: `verify` gates site sign-ups (PJ-81). accountUserHooks keep admin-created
  // users verified and stop Payload's own verification email.
  auth: { verify: true },
  hooks: {
    beforeChange: [
      ensureFirstUserIsSuperAdmin,
      preventTenantAdminCredentialChanges,
      accountUserHooks.beforeChange,
    ],
    beforeOperation: [accountUserHooks.beforeOperation],
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
