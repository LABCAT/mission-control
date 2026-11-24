import { DEFAULT_PAYLOAD_JOBS_SLUGS } from '@mission-control/payload-jobs'
import { describe, expect, it } from 'vitest'

import { siteKeyAllowedCollections } from './site-keys'

describe('site key allowlist (PJ-38) @S-222', () => {
  it('lets a site key read organisations', () => {
    expect(siteKeyAllowedCollections(DEFAULT_PAYLOAD_JOBS_SLUGS)).toContain('organisations')
  })

  it('follows a renamed organisations collection instead of the literal slug', () => {
    const allowed = siteKeyAllowedCollections({ ...DEFAULT_PAYLOAD_JOBS_SLUGS, organisations: 'companies' })
    expect(allowed).toContain('companies')
    expect(allowed).not.toContain('organisations')
  })

  it('still keeps private collections out', () => {
    const allowed = siteKeyAllowedCollections(DEFAULT_PAYLOAD_JOBS_SLUGS) as readonly string[]
    for (const slug of ['users', 'orders', 'applications', 'site-keys', 'credit-ledger', 'coupons']) {
      expect(allowed).not.toContain(slug)
    }
  })
})
