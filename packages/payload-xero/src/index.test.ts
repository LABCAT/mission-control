import type { Config } from 'payload'
import { describe, expect, it } from 'vitest'

import { payloadXero } from './index'

describe('payloadXero plugin', () => {
  it('adds the xero-settings collection without versions', async () => {
    const config = await payloadXero()({ collections: [] } as unknown as Config)
    const settings = config.collections?.find((c) => c.slug === 'xero-settings')

    expect(settings).toBeDefined()
    expect(settings?.versions).toBe(false)
  })

  it('does nothing when disabled', async () => {
    const incoming = { collections: [] } as unknown as Config

    expect(await payloadXero({ enabled: false })(incoming)).toBe(incoming)
  })

  it('refuses to shadow an existing collection', () => {
    const incoming = { collections: [{ slug: 'xero-settings', fields: [] }] } as unknown as Config

    expect(() => payloadXero()(incoming)).toThrow('already exists')
  })
})
