import type { Access } from 'payload'

/**
 * Example access rules for a multi-tenant app, used by the tests and shown in the README.
 * The plugin itself has no notion of roles: an app passes rules like these as `access`.
 */
export const GLOBAL_ROLES = ['super-admin', 'user'] as const
export const TENANT_ROLES = ['tenant-admin', 'editor', 'employer'] as const

export const globalRoleOptions = GLOBAL_ROLES.map((value) => ({ label: value, value }))
export const tenantRoleOptions = TENANT_ROLES.map((value) => ({ label: value, value }))

type RoleUser = {
  role?: null | string
  tenants?: null | { role?: null | string }[]
}

export const isSuperAdmin = (user: unknown): boolean => (user as RoleUser | null)?.role === 'super-admin'

export const authenticatedAccess: Access = ({ req }) => Boolean(req.user)

export const superAdminAccess: Access = ({ req }) => isSuperAdmin(req.user as RoleUser | null)

/** Super admins, or a user who is a tenant-admin somewhere. The tenancy layer scopes the rest. */
export const tenantAdminAccess: Access = ({ req }) => {
  const user = req.user as RoleUser | null
  if (!user) return false

  return isSuperAdmin(user) || (user.tenants ?? []).some((membership) => membership?.role === 'tenant-admin')
}
