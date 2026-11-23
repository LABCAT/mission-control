import { describe, expect, it } from 'vitest'

import { cmsFromEnv } from './site'

describe('CMS client from the environment', () => {
  it('is absent until both CMS values are set, so a checkout with no secrets still builds @S-290', () => {
    expect(cmsFromEnv({})).toBeNull()
    expect(cmsFromEnv({ CMS_URL: 'https://cms.test' })).toBeNull()
    expect(cmsFromEnv({ SITE_KEY: 'sk_test' })).toBeNull()
    expect(cmsFromEnv({ CMS_URL: '  ', SITE_KEY: 'sk_test' })).toBeNull()
  })

  it('builds the site client when both values are present', () => {
    const cms = cmsFromEnv({ CMS_URL: 'https://cms.test', SITE_KEY: 'sk_test' })

    expect(cms).not.toBeNull()
    expect(typeof cms?.findAll).toBe('function')
  })
})
