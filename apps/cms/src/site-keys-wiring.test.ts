import { describe, expect, it } from 'vitest'

import { siteKeyAccessOverride, siteKeyAllowedCollections } from './site-keys'
import { multiTenantOptions } from './tenancy'

type WiredCollection = { accessResultOverride?: unknown }

const wired = multiTenantOptions.collections as unknown as Record<
  string,
  undefined | WiredCollection
>

describe('site key wiring', () => {
  it('gives every allowlisted collection the override', () => {
    for (const slug of siteKeyAllowedCollections) {
      expect(wired[slug]?.accessResultOverride).toBe(siteKeyAccessOverride)
    }
  })

  it('wires exactly the allowlisted collections', () => {
    expect(Object.keys(wired).sort()).toEqual([...siteKeyAllowedCollections].sort())
  })
})
