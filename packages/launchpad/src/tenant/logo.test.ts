import { describe, expect, it } from 'vitest'

import { LOGO_MAX_DISPLAY_WIDTH, logoDisplaySize } from './logo'

describe('logoDisplaySize', () => {
  it('shows a wide logo at no more than the cap, keeping its shape, so a phone gets 2x pixels @S-362', () => {
    // vwok's 400 x 86 logo: 200 x 43 has the same ratio, and the file has 2x the pixels it needs.
    expect(logoDisplaySize({ height: 86, width: 400 })).toEqual({ height: 43, width: 200 })
    expect(LOGO_MAX_DISPLAY_WIDTH).toBe(200)
  })

  it('never enlarges a small logo @S-362', () => {
    expect(logoDisplaySize({ height: 40, width: 120 })).toEqual({ height: 40, width: 120 })
  })

  it('rounds to whole pixels and never returns a zero side @S-362', () => {
    expect(logoDisplaySize({ height: 1, width: 1000 })).toEqual({ height: 1, width: 200 })
    expect(logoDisplaySize({ height: 333, width: 1000 })).toEqual({ height: 67, width: 200 })
  })

  it('leaves a logo without a real size to the browser @S-362', () => {
    expect(logoDisplaySize({})).toEqual({})
    expect(logoDisplaySize({ width: 400 })).toEqual({})
    expect(logoDisplaySize({ height: 0, width: 400 })).toEqual({})
    expect(logoDisplaySize({ height: null, width: null })).toEqual({})
  })
})
