import { describe, expect, it } from 'vitest'

import { userIDFromPath, viewAsChoices } from './admin/ViewAsUserButton'
import { signViewAsToken, verifyViewAsToken, VIEW_AS_ACCOUNT_ROLES, VIEW_AS_EDITABLE_USER_FIELDS } from './view-as'

const claims = { adm: 1, exp: 2_000_000_000, sid: 'sid-1', sub: 7, tid: 3 }
const NOW = 1_900_000_000

describe('view-as token @S-157', () => {
  it('round-trips its claims', async () => {
    const token = await signViewAsToken('secret', claims)

    expect(token.startsWith('mcva1.')).toBe(true)
    expect(await verifyViewAsToken('secret', token, NOW)).toEqual(claims)
  })

  it('is not a JWT, so Payload never accepts it as a normal session', async () => {
    const token = await signViewAsToken('secret', claims)

    expect(token.split('.')).toHaveLength(3)
    expect(() => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())).toThrow()
  })

  it('rejects a different secret, tampered claims and a tampered signature', async () => {
    const token = await signViewAsToken('secret', claims)
    const [prefix, body, signature] = token.split('.') as [string, string, string]
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 1 })).toString('base64url')

    expect(await verifyViewAsToken('other secret', token, NOW)).toBeNull()
    expect(await verifyViewAsToken('secret', `${prefix}.${forged}.${signature}`, NOW)).toBeNull()
    expect(await verifyViewAsToken('secret', `${prefix}.${body}.${signature.slice(0, -2)}AA`, NOW)).toBeNull()
  })

  it('rejects an expired token and malformed ones', async () => {
    const token = await signViewAsToken('secret', claims)

    expect(await verifyViewAsToken('secret', token, claims.exp)).toBeNull()
    expect(await verifyViewAsToken('secret', token, claims.exp + 1)).toBeNull()

    for (const bad of ['', 'mcva1', 'mcva1.a.b', 'mcva1.a.b.c', 'eyJhbGciOi.eyJ.sig', 'jwt.a.b']) {
      expect(await verifyViewAsToken('secret', bad, NOW), bad).toBeNull()
    }
  })

  it('rejects claims of the wrong type, even with a valid signature', async () => {
    const token = await signViewAsToken('secret', { ...claims, sid: 5 as never })

    expect(await verifyViewAsToken('secret', token, NOW)).toBeNull()
  })
})

describe('view-as rules @S-158', () => {
  it('only site roles can be viewed, and only the name can be edited', () => {
    expect([...VIEW_AS_ACCOUNT_ROLES]).toEqual(['seeker', 'employer'])
    expect([...VIEW_AS_EDITABLE_USER_FIELDS]).toEqual(['firstName', 'lastName'])
  })
})

describe('"View as this user" button @S-073', () => {
  it('reads the user id from the admin URL', () => {
    expect(userIDFromPath('/admin/collections/users/12')).toBe('12')
    expect(userIDFromPath('/admin/collections/users/12/')).toBe('12')
    expect(userIDFromPath('/admin/collections/users/create')).toBeNull()
    expect(userIDFromPath('/admin/collections/jobs/12')).toBeNull()
    expect(userIDFromPath('/admin')).toBeNull()
  })

  const tenant = (id: number, slug: string) => ({ id, name: slug.toUpperCase(), slug })

  it('offers one choice per site account tenant', () => {
    expect(
      viewAsChoices({
        role: 'user',
        tenants: [
          { role: 'seeker', tenant: tenant(1, 'a') },
          { role: 'employer', tenant: tenant(2, 'b') },
        ],
      }),
    ).toEqual([
      { label: 'A', slug: 'a' },
      { label: 'B', slug: 'b' },
    ])
  })

  it('offers nothing for a super admin, staff or an unpopulated tenant', () => {
    expect(viewAsChoices({ role: 'super-admin', tenants: [{ role: 'seeker', tenant: tenant(1, 'a') }] })).toEqual([])
    expect(
      viewAsChoices({
        role: 'user',
        tenants: [
          { role: 'seeker', tenant: tenant(1, 'a') },
          { role: 'editor', tenant: tenant(2, 'b') },
        ],
      }),
    ).toEqual([])
    expect(viewAsChoices({ role: 'user', tenants: [{ role: 'seeker', tenant: 1 }] })).toEqual([])
    expect(viewAsChoices({ role: 'user', tenants: null })).toEqual([])
  })
})
