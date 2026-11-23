import { describe, expect, it } from 'vitest'

import { mayRemove, userIDFromPath } from './RemovePersonalDataButton'

describe('userIDFromPath @S-311', () => {
  it('reads the user id from the admin edit URL @S-311', () => {
    expect(userIDFromPath('/admin/collections/users/12')).toBe('12')
    expect(userIDFromPath('/admin/collections/users/12/')).toBe('12')
  })

  it('returns null where there is no user to act on @S-311', () => {
    expect(userIDFromPath('/admin/collections/users')).toBeNull()
    expect(userIDFromPath('/admin/collections/users/create')).toBeNull()
    expect(userIDFromPath('/admin/collections/orders/12')).toBeNull()
  })
})

describe('mayRemove @S-311', () => {
  const superAdmin = { id: 1, role: 'super-admin' }
  const siteManager = { id: 2, role: 'user' }
  const member = { id: 3, role: 'user', tenants: [{ tenant: 7 }] }

  it('shows the action to a super admin, but never on their own account @S-311', () => {
    expect(mayRemove(superAdmin, member)).toBe(true)
    expect(mayRemove(superAdmin, { id: 1, role: 'super-admin', tenants: [] })).toBe(false)
  })

  it('shows the action to a site manager for a site member, not for a super admin @S-311', () => {
    expect(mayRemove(siteManager, member)).toBe(true)
    expect(mayRemove(siteManager, superAdmin)).toBe(false)
  })

  it('hides the action from an anonymous visitor and for a user with no site @S-311', () => {
    expect(mayRemove(undefined, member)).toBe(false)
    expect(mayRemove(siteManager, { id: 4, role: 'user', tenants: [] })).toBe(false)
    expect(mayRemove(siteManager, { id: 5, role: 'user', tenants: null })).toBe(false)
  })
})
