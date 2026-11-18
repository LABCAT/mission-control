import type { Access, FieldAccess } from 'payload'

export const GLOBAL_ROLES = ['super-admin', 'user'] as const
export type GlobalRole = (typeof GLOBAL_ROLES)[number]

export const TENANT_ROLES = ['tenant-admin', 'editor', 'employer', 'seeker'] as const
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

const tenantRoleLabels: Record<TenantRole, string> = {
  'tenant-admin': 'Tenant admin',
  editor: 'Editor',
  employer: 'Employer',
  seeker: 'Job seeker',
}

export const tenantRoleOptions = TENANT_ROLES.map((value) => ({
  label: tenantRoleLabels[value],
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

/** Roles allowed to edit CMS content (pages, site settings). */
export const CONTENT_ROLES = ['tenant-admin', 'editor'] as const

/**
 * Content editors: super-admins, plus tenant-admins and editors in at least one tenant. The
 * multi-tenant plugin narrows the result to the user's own tenants, so this only answers
 * "may this user write content at all". Employers and anonymous visitors get false.
 *
 * Single-tenant hosts have no tenant memberships, so they pass `allowAnyAuthenticated` and
 * any signed-in user may edit content.
 */
export const contentWriteAccess =
  ({ allowAnyAuthenticated = false }: { allowAnyAuthenticated?: boolean } = {}): Access =>
  ({ req }) => {
    if (!req.user) return false

    const user = req.user as MissionControlUser
    if (isSuperAdmin(user) || hasAnyTenantRole(user, CONTENT_ROLES)) return true

    return allowAnyAuthenticated && (user.tenants ?? []).length === 0
  }

/**
 * A user who is a member of at least one tenant and holds only the `seeker` role everywhere.
 * Seekers use the dashboards on the Astro sites. They never use the admin and never touch
 * tenant content, so admin access and tenant-scoped collection access exclude them.
 */
export const isSeekerOnly = (user: MissionControlUser | null | undefined): boolean => {
  if (!user || isSuperAdmin(user)) return false

  const memberships = user.tenants ?? []

  return memberships.length > 0 && memberships.every((membership) => membership?.role === 'seeker')
}

/** Admin panel access: everyone who can sign in, except seeker-only users. */
export const adminPanelAccess = ({ req }: { req: { user?: unknown } }): boolean =>
  Boolean(req.user) && !isSeekerOnly(req.user as MissionControlUser)

type AccessOverrideArgs = { req: { user?: unknown } }

/**
 * Wrap a multi-tenant `accessResultOverride` so seeker-only users get no access to the
 * collection. The multi-tenant plugin grants every member of a tenant access to that tenant's
 * documents whatever their role, so without this a seeker could write media, tags and folders.
 */
export const denySeekerOnly =
  <Args extends AccessOverrideArgs, Result>(next: (args: Args) => Promise<Result> | Result) =>
  async (args: Args): Promise<false | Result> =>
    isSeekerOnly(args.req.user as MissionControlUser | null | undefined) ? false : next(args)
