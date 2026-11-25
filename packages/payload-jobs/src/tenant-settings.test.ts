import { describe, expect, it } from 'vitest'

import { PUBLIC_TENANT_SETTINGS_FIELDS, publicTenantSettings } from './tenant-settings'

describe('publicTenantSettings @S-124', () => {
  it('publishes the AI-crawler switch only when it is the explicit blocker', () => {
    expect(publicTenantSettings({ id: 1, name: 'Vanuatu Wok', slug: 'vwok' })?.allowAiCrawlers).toBeUndefined()
    expect(
      publicTenantSettings({ allowAiCrawlers: true, id: 1, name: 'Vanuatu Wok', slug: 'vwok' })?.allowAiCrawlers,
    ).toBeUndefined()
    expect(
      publicTenantSettings({ allowAiCrawlers: false, id: 1, name: 'Vanuatu Wok', slug: 'vwok' })?.allowAiCrawlers,
    ).toBe(false)
  })

  it('keeps the switch in the allow-list, so a new field is never published by accident', () => {
    expect(PUBLIC_TENANT_SETTINGS_FIELDS).toContain('allowAiCrawlers')
  })

  it('drops a tenant with no name, which no site can render', () => {
    expect(publicTenantSettings({ id: 1, slug: 'vwok' })).toBeNull()
  })
})
