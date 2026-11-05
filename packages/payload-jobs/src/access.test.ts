import type { AccessArgs } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  getTenantRole,
  getUserTenantIDs,
  hasAnyTenantRole,
  hasTenantRole,
  isSuperAdmin,
  type MissionControlUser,
  superAdminAccess,
} from './access'

const tenantAdminA = {
  id: 1,
  role: 'user',
  tenants: [
    { role: 'tenant-admin', tenant: { id: 10 } },
    { role: 'editor', tenant: 20 },
  ],
} satisfies MissionControlUser

describe('tenant roles', () => {
  it('reads roles from both populated and id-only tenant references', () => {
    expect(getTenantRole(tenantAdminA, 10)).toBe('tenant-admin')
    expect(getTenantRole(tenantAdminA, '20')).toBe('editor')
    expect(getTenantRole(tenantAdminA, 30)).toBeNull()
    expect(getUserTenantIDs(tenantAdminA)).toEqual([10, 20])
  })

  it('does not grant a role in a tenant the user is not a member of', () => {
    expect(hasTenantRole(tenantAdminA, 10, ['tenant-admin'])).toBe(true)
    expect(hasTenantRole(tenantAdminA, 20, ['tenant-admin'])).toBe(false)
    expect(hasTenantRole(tenantAdminA, 30, ['tenant-admin', 'editor', 'employer'])).toBe(false)
    expect(hasAnyTenantRole(tenantAdminA, ['tenant-admin'])).toBe(true)
    expect(hasAnyTenantRole(tenantAdminA, ['employer'])).toBe(false)
  })

  it('only treats the global super-admin role as global access', () => {
    expect(isSuperAdmin({ role: 'super-admin' })).toBe(true)
    expect(isSuperAdmin({ role: 'user', tenants: [{ role: 'tenant-admin', tenant: 10 }] })).toBe(
      false,
    )
    expect(isSuperAdmin(null)).toBe(false)
  })
})

const argsFor = (user: MissionControlUser | null): AccessArgs =>
  ({ req: { user } }) as unknown as AccessArgs

describe('superAdminAccess', () => {
  it('allows super-admins and denies everyone else', async () => {
    expect(await superAdminAccess(argsFor({ role: 'super-admin' }))).toBe(true)
    expect(await superAdminAccess(argsFor(tenantAdminA))).toBe(false)
    expect(await superAdminAccess(argsFor(null))).toBe(false)
  })
})
