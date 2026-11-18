import { describe, expect, it } from 'vitest'

import {
  brandingStyle,
  brandingStyleAttribute,
  brandingTokens,
  normaliseHex,
  readableOn,
  relativeLuminance,
} from './branding'

describe('normaliseHex', () => {
  it('expands three-digit hex and lowercases six-digit hex', () => {
    expect(normaliseHex('#069')).toBe('#006699')
    expect(normaliseHex('#06914B')).toBe('#06914b')
    expect(normaliseHex('  #DD3333 ')).toBe('#dd3333')
  })

  it('rejects anything that is not a plain hex colour', () => {
    expect(normaliseHex(undefined)).toBeUndefined()
    expect(normaliseHex('')).toBeUndefined()
    expect(normaliseHex('06914b')).toBeUndefined()
    expect(normaliseHex('red')).toBeUndefined()
    expect(normaliseHex('var(--rs-color-accent)')).toBeUndefined()
    // A value that could break out of the declaration must never reach the stylesheet.
    expect(normaliseHex('#06914b; background: url(evil)')).toBeUndefined()
    expect(normaliseHex('#06914b}')).toBeUndefined()
  })
})

describe('readableOn', () => {
  it('picks the better of black and white, by WCAG relative luminance', () => {
    // #06914b is light enough for black text; #0066bf is dark enough to need white.
    expect(readableOn('#06914b')).toBe('#000000')
    expect(readableOn('#0066bf')).toBe('#ffffff')
    expect(readableOn('#0a5c33')).toBe('#ffffff')
    expect(readableOn('#ffffff')).toBe('#000000')
    expect(readableOn('#ffe600')).toBe('#000000')
  })
})

describe('relativeLuminance', () => {
  it('matches the WCAG reference values', () => {
    expect(relativeLuminance('#000000')).toBe(0)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
    expect(relativeLuminance('#808080')).toBeCloseTo(0.2158, 3)
  })

  it('throws on an invalid colour instead of returning nonsense', () => {
    expect(() => relativeLuminance('green')).toThrow(TypeError)
  })
})

describe('brandingTokens', () => {
  it('maps tenant branding onto Rocketship colour tokens only', () => {
    const tokens = brandingTokens({
      colorAccent: '#DD3333',
      colorHover: '#B02A2A',
      colorPrimary: '#06914b',
    })

    expect(tokens).toEqual({
      '--rs-color-accent': '#06914b',
      '--rs-color-accent-contrast': '#000000',
      '--rs-color-accent-hover': '#b02a2a',
      '--rs-color-focus-ring': '#dd3333',
      '--rs-color-link': '#06914b',
      '--rs-color-link-hover': '#b02a2a',
    })

    // Nothing outside the documented `--rs-*` namespace is ever produced.
    for (const property of Object.keys(tokens)) {
      expect(property.startsWith('--rs-')).toBe(true)
    }
  })

  it('emits only the tokens the tenant set', () => {
    expect(brandingTokens({ colorPrimary: '#0066bf' })).toEqual({
      '--rs-color-accent': '#0066bf',
      '--rs-color-accent-contrast': '#ffffff',
      '--rs-color-link': '#0066bf',
    })
    expect(brandingTokens(null)).toEqual({})
    expect(brandingTokens({})).toEqual({})
  })

  it('skips invalid colours rather than emitting a broken declaration', () => {
    expect(brandingTokens({ colorAccent: 'javascript:alert(1)', colorPrimary: '#123' })).toEqual({
      '--rs-color-accent': '#112233',
      '--rs-color-accent-contrast': '#ffffff',
      '--rs-color-link': '#112233',
    })
  })
})

describe('brandingStyle', () => {
  it('writes the tokens as one rule, sorted for a stable byte-for-byte result', () => {
    expect(brandingStyle({ colorPrimary: '#000' })).toBe(
      ':root { --rs-color-accent: #000000; --rs-color-accent-contrast: #ffffff; --rs-color-link: #000000; }',
    )
  })

  it('is empty when the tenant has no branding, so the layout renders nothing', () => {
    expect(brandingStyle(undefined)).toBe('')
    expect(brandingStyle({})).toBe('')
  })
})

describe('brandingStyleAttribute', () => {
  it('is the declarations without a selector or braces, ready for a style attribute', () => {
    expect(brandingStyleAttribute({ colorPrimary: '#06914b' })).toBe(
      '--rs-color-accent: #06914b; --rs-color-accent-contrast: #000000; --rs-color-link: #06914b',
    )
  })

  it('is undefined when there is nothing to set, so the attribute is omitted', () => {
    expect(brandingStyleAttribute(null)).toBeUndefined()
    expect(brandingStyleAttribute({ colorPrimary: 'green' })).toBeUndefined()
  })
})
