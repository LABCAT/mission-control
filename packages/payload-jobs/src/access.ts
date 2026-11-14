import type { Access, FieldAccess } from 'payload'

export const GLOBAL_ROLES = ['super-admin', 'user'] as const
export type GlobalRole = (typeof GLOBAL_ROLES)[number]

export const TENANT_ROLES = ['tenant-admin', 'editor', 'employer'] as const
export type TenantRole = (typeof TENANT_ROLES)[number]

type TenantReference = null | number | string | { id: number | string }

export type MissionControlUser = {
  id?: number | string
  role?: GlobalRole | null
  tenants?:
    | null
    | {
        role?: TenantRole | null
        tenant?: TenantReference
      }[]
}

export const globalRoleOptions = GLOBAL_ROLES.map((value) => ({
  label: value === 'super-admin' ? 'Super admin' : 'User',
  value,
}))

export const tenantRoleOptions = TENANT_ROLES.map((value) => ({
  label: value === 'tenant-admin' ? 'Tenant admin' : value === 'editor' ? 'Editor' : 'Employer',
  value,
}))

/** Super admins are the only users who can see and change every tenant. */
export const isSuperAdmin = (user: MissionControlUser | null | undefined): boolean =>
  user?.role === 'super-admin'

export const authenticatedAccess: Access = ({ req }) => Boolean(req.user)

export const superAdminAccess: Access = ({ req }) =>
  isSuperAdmin(req.user as MissionControlUser | null | undefined)

export const superAdminFieldAccess: FieldAccess = ({ req }) =>
  isSuperAdmin(req.user as MissionControlUser | null | undefined)

const tenantIDOf = (tenant: TenantReference | undefined): number | string | null => {
  if (tenant === null || tenant === undefined) return null
  if (typeof tenant === 'object') return tenant.id
  return tenant
}

export const getUserTenantIDs = (
  user: MissionControlUser | null | undefined,
): (number | string)[] => {
  const ids: (number | string)[] = []

  for (const membership of user?.tenants ?? []) {
    const id = tenantIDOf(membership?.tenant)
    if (id !== null) ids.push(id)
  }

  return ids
}

export const getUserTenantIDsByRole = (
  user: MissionControlUser | null | undefined,
  roles: readonly TenantRole[],
): (number | string)[] => {
  const ids: (number | string)[] = []

  for (const membership of user?.tenants ?? []) {
    if (membership?.role == null || !roles.includes(membership.role)) continue
    const id = tenantIDOf(membership.tenant)
    if (id !== null) ids.push(id)
  }

  return ids
}

/** The user's role inside one tenant, or null when they are not a member. */
export const getTenantRole = (
  user: MissionControlUser | null | undefined,
  tenantID: number | string,
): TenantRole | null => {
  const target = String(tenantID)

  for (const membership of user?.tenants ?? []) {
    const id = tenantIDOf(membership?.tenant)
    if (id !== null && String(id) === target) return membership?.role ?? null
  }

  return null
}

export const hasTenantRole = (
  user: MissionControlUser | null | undefined,
  tenantID: number | string,
  roles: readonly TenantRole[],
): boolean => {
  const role = getTenantRole(user, tenantID)
  return role !== null && roles.includes(role)
}

export const hasAnyTenantRole = (
  user: MissionControlUser | null | undefined,
  roles: readonly TenantRole[],
): boolean =>
  (user?.tenants ?? []).some(
    (membership) => membership?.role != null && roles.includes(membership.role),
  )

/**
 * Who may write job-board content (locations, taxonomies, jobs): super admins and the
 * tenant-admin/editor memberships of at least one tenant. The multi-tenant plugin adds the
 * tenant constraint on top, so this only decides the role — employers are excluded.
 */
export const tenantContentWriteAccess: Access = ({ req }) => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return false
  if (isSuperAdmin(user)) return true

  return hasAnyTenantRole(user, ['tenant-admin', 'editor'])
}
