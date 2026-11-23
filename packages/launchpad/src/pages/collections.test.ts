import { describe, expect, it } from 'vitest'

import { DEFAULT_SITE_COLLECTIONS, siteCollections } from './collections'

describe('site collection slugs', () => {
  it('reads the plugin defaults when a site renames nothing @S-290', () => {
    expect(siteCollections()).toEqual(DEFAULT_SITE_COLLECTIONS)
  })

  it('takes the slugs a site resolves from the plugin options @S-290', () => {
    expect(siteCollections({ pages: 'content-pages' })).toEqual({
      ...DEFAULT_SITE_COLLECTIONS,
      pages: 'content-pages',
    })
  })
})
