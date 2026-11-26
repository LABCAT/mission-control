import { describe, expect, it } from 'vitest'

import { emailSuppressionsCollection } from './suppressions'

describe('email suppression list access @S-386', () => {
  const { access } = emailSuppressionsCollection()
  const as = (user: unknown) => ({ req: { user } }) as never
  const member = (role: string) => ({ role: 'user', tenants: [{ role, tenant: 1 }] })

  it.each(['read', 'delete'] as const)('%s: staff yes, employers, seekers and anonymous no', (operation) => {
    const check = access![operation]!
    expect(check(as({ role: 'super-admin' }))).toBe(true)
    expect(check(as(member('tenant-admin')))).toBe(true)
    expect(check(as(member('editor')))).toBe(true)
    expect(check(as(member('employer')))).toBe(false)
    expect(check(as(member('seeker')))).toBe(false)
    expect(check(as(null))).toBe(false)
  })

  it('the system alone creates and updates rows', () => {
    expect(access!.create!(as({ role: 'super-admin' }))).toBe(false)
    expect(access!.update!(as({ role: 'super-admin' }))).toBe(false)
  })
})
