import { describe, expect, it } from 'vitest'

import { xeroSettingsSeedProblems } from '@mission-control/payload-jobs-xero'

import { vwokXero } from './vwok-xero'

describe('vwok Xero seed @S-102', () => {
  it('matches the old site’s Xero plugin options', () => {
    expect(vwokXero).toEqual({
      accountCodes: { addOn: '226', discount: '227', plan: '225' },
      authorise: true,
      dueDays: 14,
      reconciliationAccountCode: null,
      trackingCategory: null,
    })
    expect(xeroSettingsSeedProblems(vwokXero)).toEqual([])
  })
})
