import { describe, expect, it } from 'vitest'

import { canShowApprove, jobFromPath } from './ApproveJobButton'

describe('Approve button visibility @S-194', () => {
  const pending = { status: 'pending', tenant: 3 }
  const siteManager = { role: 'user', tenants: [{ role: 'tenant-admin', tenant: 3 }] }

  it('reads the job from the admin url', () => {
    expect(jobFromPath('/admin/collections/jobs/12')).toEqual({ id: '12', slug: 'jobs' })
    expect(jobFromPath('/admin/collections/jobs/create')).toBeNull()
    expect(jobFromPath('/admin/collections/jobs')).toBeNull()
  })

  it('shows for a super admin, or a site manager of the job’s tenant, on a pending job only', () => {
    expect(canShowApprove({ role: 'super-admin' }, pending)).toBe(true)
    expect(canShowApprove(siteManager, pending)).toBe(true)
    expect(canShowApprove({ role: 'user', tenants: [{ role: 'editor', tenant: { id: 3 } }] }, pending)).toBe(true)
    for (const status of ['draft', 'waiting_for_purchase', 'published', 'expired', 'cancelled']) {
      expect(canShowApprove(siteManager, { ...pending, status })).toBe(false)
    }
  })

  it('hides for employers, seekers, another tenant’s manager and signed-out visitors', () => {
    expect(canShowApprove({ role: 'user', tenants: [{ role: 'employer', tenant: 3 }] }, pending)).toBe(false)
    expect(canShowApprove({ role: 'user', tenants: [{ role: 'seeker', tenant: 3 }] }, pending)).toBe(false)
    expect(canShowApprove({ role: 'user', tenants: [{ role: 'tenant-admin', tenant: 4 }] }, pending)).toBe(false)
    expect(canShowApprove(siteManager, { status: 'pending', tenant: null })).toBe(false)
    expect(canShowApprove(null, pending)).toBe(false)
  })
})
