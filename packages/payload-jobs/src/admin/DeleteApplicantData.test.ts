import { describe, expect, it } from 'vitest'

import { applicationIDFromPath, mayDeleteApplication } from './DeleteApplicantData'

describe('DeleteApplicantData button @S-303', () => {
  it('reads the application id from the admin URL', () => {
    expect(applicationIDFromPath('/admin/collections/applications/12', 'applications')).toBe('12')
    expect(applicationIDFromPath('/admin/collections/applications/12/', 'applications')).toBe('12')
    expect(applicationIDFromPath('/admin/collections/applications/create', 'applications')).toBeNull()
    expect(applicationIDFromPath('/admin/collections/applications', 'applications')).toBeNull()
    expect(applicationIDFromPath('/admin/collections/jobs/12', 'applications')).toBeNull()
  })

  it('shows to a super admin and to an admin of the application’s own tenant only', () => {
    const row = { tenant: 1 }

    expect(mayDeleteApplication({ id: 1, role: 'super-admin' }, row)).toBe(true)
    expect(mayDeleteApplication({ id: 2, tenants: [{ role: 'tenant-admin', tenant: 1 }] }, row)).toBe(true)
    expect(mayDeleteApplication({ id: 2, tenants: [{ role: 'tenant-admin', tenant: { id: 1 } }] }, row)).toBe(true)
    // An admin of another tenant would only meet a 403.
    expect(mayDeleteApplication({ id: 3, tenants: [{ role: 'tenant-admin', tenant: 2 }] }, row)).toBe(false)
    expect(mayDeleteApplication({ id: 4, tenants: [{ role: 'tenant-viewer', tenant: 1 }] }, row)).toBe(false)
    expect(mayDeleteApplication(null, row)).toBe(false)
  })

  it('lets any tenant admin act on a single-tenant site, where the row has no tenant', () => {
    expect(mayDeleteApplication({ id: 2, tenants: [{ role: 'tenant-admin', tenant: 9 }] }, {})).toBe(true)
    expect(mayDeleteApplication({ id: 2, tenants: [] }, {})).toBe(false)
  })
})

describe('DeleteApplicantData markup @S-303', () => {
  it('is not a <form>: the admin renders it inside the document form, where a nested submit does nothing', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('./DeleteApplicantData.tsx', import.meta.url), 'utf8')

    expect(source).not.toMatch(/<form[\s>]/)
    expect(source).toContain('type="button"')
    expect(source).toContain('window.confirm(')
  })
})
