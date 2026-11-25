import { describe, expect, it } from 'vitest'

import { tenantFromSettings } from './tenant-settings'
import type { SiteTenant } from '../tenant/types'

const fallback: SiteTenant = {
  currency: 'VUV',
  currencyMinorUnits: 0,
  defaultLocale: 'en',
  name: 'Vanuatu Wok',
  slug: 'vwok',
  timezone: 'Pacific/Efate',
}

describe('tenantFromSettings and the AI-crawler switch (PJ-104) @S-124', () => {
  it('carries the tenant’s explicit no over the site’s fallback', () => {
    expect(tenantFromSettings({ allowAiCrawlers: false, name: 'Vanuatu Wok', slug: 'vwok' }, fallback).allowAiCrawlers).toBe(false)
  })

  it('leaves the fallback alone when the CMS never answers the question', () => {
    // An older tenant row, or a settings response from before the switch existed, must not read
    // as a block: the documented default is allow.
    expect(tenantFromSettings({ name: 'Vanuatu Wok', slug: 'vwok' }, fallback)).not.toHaveProperty('allowAiCrawlers', false)
    expect(tenantFromSettings({ allowAiCrawlers: true, name: 'Vanuatu Wok', slug: 'vwok' }, fallback)).not.toHaveProperty(
      'allowAiCrawlers',
      false,
    )
  })

  it('does not let the switch overwrite the site branding or currency', () => {
    const tenant = tenantFromSettings(
      { allowAiCrawlers: false, currency: 'AUD', currencyMinorUnits: 2, name: 'Vanuatu Wok', slug: 'vwok' },
      fallback,
    )

    expect(tenant).toMatchObject({ allowAiCrawlers: false, currency: 'AUD', currencyMinorUnits: 2 })
    expect(tenant.name).toBe('Vanuatu Wok')
  })
})
