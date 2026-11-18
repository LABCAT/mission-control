import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadXero } from './index'

const run = (options: Parameters<typeof payloadXero>[0], collections: unknown[] = []) =>
  payloadXero(options)({ collections } as unknown as Config) as Config

const allowRead = () => true

describe('payloadXero plugin', () => {
  it('adds the settings collection without versions, global scope by default', () => {
    const config = run(undefined)
    const settings = config.collections?.find((c) => c.slug === 'xero-settings')

    expect(settings?.versions).toBe(false)
    expect(config.custom?.payloadXero).toMatchObject({ scope: 'global', settingsSlug: 'xero-settings' })
  })

  it('uses a configurable slug and scope', () => {
    const config = run({ scope: 'tenant', settingsSlug: 'accounting-xero' })

    expect(config.collections?.map((c) => c.slug)).toEqual(['accounting-xero'])
    expect(config.custom?.payloadXero).toMatchObject({ scope: 'tenant', settingsSlug: 'accounting-xero' })
  })

  it('passes access options through', () => {
    const settings = run({ access: { read: allowRead } }).collections?.[0]

    expect(settings?.access?.read).toBe(allowRead)
    expect(settings?.access?.update).toBeTypeOf('function')
  })

  it('does nothing when disabled', () => {
    const incoming = { collections: [] } as unknown as Config

    expect(payloadXero({ enabled: false })(incoming)).toBe(incoming)
  })

  it('refuses to shadow an existing collection', () => {
    expect(() => run(undefined, [{ slug: 'xero-settings', fields: [] }])).toThrow('already exists')
    expect(() => run({ settingsSlug: 'x' }, [{ slug: 'x', fields: [] }])).toThrow('already exists')
  })
})
