import { describe, expect, it } from 'vitest'

import { adminCollectionPath } from './links'

describe('admin links @S-117', () => {
  it('builds the dashboard links from the host’s own admin route', () => {
    expect(adminCollectionPath('admin', 'jobs')).toBe('/admin/collections/jobs')
    expect(adminCollectionPath('/cms/', 'jobs', 12)).toBe('/cms/collections/jobs/12')
  })

  it('escapes an id rather than letting it rewrite the path', () => {
    expect(adminCollectionPath('admin', 'orders', 'a/b')).toBe('/admin/collections/orders/a%2Fb')
  })
})
