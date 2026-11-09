import { hashSiteKey } from '@mission-control/payload-jobs'
import { describe, expect, it } from 'vitest'

import { generateSiteKeyOnCreate, hideSiteKeyHash, revealSiteKeyOnce } from './SiteKeys'
import { removeTenantSiteKeys } from './Tenants'

describe('site key hooks', () => {
  it('generates the digest on create and keeps the raw key out of the data', async () => {
    const context: Record<string, unknown> = {}
    const data = await generateSiteKeyOnCreate({
      data: { label: 'web', tenant: 1 },
      operation: 'create',
      req: { context },
    } as never)

    const rawKey = context.missionControlRawSiteKey

    expect(data.keyHash).toMatch(/^[0-9a-f]{64}$/)
    expect(data).not.toHaveProperty('key')
    expect(typeof rawKey).toBe('string')
    expect(await hashSiteKey(rawKey as string)).toBe(data.keyHash)
  })

  it('leaves updates untouched', async () => {
    const data = { label: 'renamed' }
    const result = await generateSiteKeyOnCreate({
      data,
      operation: 'update',
      req: { context: {} },
    } as never)

    expect(result).toBe(data)
  })

  it('reveals the raw key once on create', async () => {
    const context: Record<string, unknown> = { missionControlRawSiteKey: 'sk_raw' }
    const result = await revealSiteKeyOnce({
      doc: { id: 1 },
      operation: 'create',
      req: { context },
    } as never)

    expect(result).toEqual({ id: 1, key: 'sk_raw' })
    expect(context.missionControlRawSiteKey).toBeUndefined()
  })

  it('does not reveal the key on update', async () => {
    const doc = { id: 1 }
    const context: Record<string, unknown> = { missionControlRawSiteKey: 'sk_raw' }
    const result = await revealSiteKeyOnce({ doc, operation: 'update', req: { context } } as never)

    expect(result).toBe(doc)
  })

  it('strips the digest even when field access is overridden', () => {
    const result = hideSiteKeyHash({ doc: { id: 1, keyHash: 'abc', label: 'web' } } as never)

    expect(result).toEqual({ id: 1, label: 'web' })
  })
})

describe('tenant deletion', () => {
  it('deletes the tenant site keys before the tenant row', async () => {
    const deletes: unknown[] = []
    const req = {
      payload: {
        delete: async (args: unknown) => {
          deletes.push(args)
          return {}
        },
      },
    }

    await removeTenantSiteKeys({ id: 7, req } as never)

    expect(deletes).toEqual([
      expect.objectContaining({
        collection: 'site-keys',
        overrideAccess: true,
        where: { tenant: { equals: 7 } },
      }),
    ])
  })
})
