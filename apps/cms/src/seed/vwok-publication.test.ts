import { describe, expect, it } from 'vitest'

import { DEFAULT_PUBLICATION_SETTINGS, publicationDecisionFor } from '@mission-control/payload-jobs'

import { vwokPublication } from './vwok-publication'

describe('vwok publication seed @S-193', () => {
  it('is the legacy rule, and the generic default', () => {
    expect(vwokPublication).toEqual(DEFAULT_PUBLICATION_SETTINGS)
  })

  it('publishes a trusted employer at once and holds a new employer for approval', () => {
    for (const payment of ['invoiced', 'paid', 'none'] as const) {
      expect(publicationDecisionFor({ payment, settings: vwokPublication, trusted: true })).toBe('published')
      expect(publicationDecisionFor({ payment, settings: vwokPublication, trusted: false })).toBe('pending')
    }
  })
})
