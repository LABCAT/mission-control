import type { AccessArgs } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  adminPanelAccess,
  denySeekerOnly,
  getTenantRole,
  getUserTenantIDs,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  hasTenantRole,
  isSeekerOnly,
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
    expect(getUserTenantIDsByRole(tenantAdminA, ['tenant-admin'])).toEqual([10])
    expect(getUserTenantIDsByRole(tenantAdminA, ['editor'])).toEqual([20])
    expect(getUserTenantIDsByRole(tenantAdminA, ['employer'])).toEqual([])
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

const next = async () => ({ tenant: { equals: 10 } })

describe('seekers', () => {
  const seeker = {
    id: 5,
    role: 'user',
    tenants: [{ role: 'seeker', tenant: 10 }],
  } satisfies MissionControlUser
  const seekerAndEmployer = {
    id: 6,
    role: 'user',
    tenants: [
      { role: 'seeker', tenant: 10 },
      { role: 'employer', tenant: 20 },
    ],
  } satisfies MissionControlUser

  it('treats only users whose every membership is a seeker as seeker-only', () => {
    expect(isSeekerOnly(seeker)).toBe(true)
    expect(isSeekerOnly(seekerAndEmployer)).toBe(false)
    expect(isSeekerOnly(tenantAdminA)).toBe(false)
    expect(isSeekerOnly({ id: 7, role: 'super-admin', tenants: [] })).toBe(false)
    expect(isSeekerOnly({ id: 8, role: 'user', tenants: [] })).toBe(false)
    expect(isSeekerOnly(null)).toBe(false)
  })

  it('keeps seekers out of the admin panel', () => {
    expect(adminPanelAccess({ req: { user: seeker } })).toBe(false)
    expect(adminPanelAccess({ req: { user: seekerAndEmployer } })).toBe(true)
    expect(adminPanelAccess({ req: { user: tenantAdminA } })).toBe(true)
    expect(adminPanelAccess({ req: { user: null } })).toBe(false)
  })

  it('denies seekers tenant content and passes everyone else through', async () => {
    const guarded = denySeekerOnly(next)

    expect(await guarded({ req: { user: seeker } })).toBe(false)
    expect(await guarded({ req: { user: tenantAdminA } })).toEqual({ tenant: { equals: 10 } })
    // An anonymous request (a site key) still reaches the site key override.
    expect(await guarded({ req: { user: null } })).toEqual({ tenant: { equals: 10 } })
  })
})
