import { describe, expect, it } from 'vitest'

import { safeHref } from './href'

const unsafe = [
  'javascript:alert(1)',
  'JaVaScRiPt:alert(1)',
  ' javascript:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  'java script:alert(1)',
  '\u0000javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//evil.com',
  '/\\evil.com',
]

const safe = [
  '/jobs',
  '/jobs?category=trades#top',
  '#top',
  '?q=vanuatu',
  'https://example.com/jobs',
  'http://example.com',
  'HTTPS://EXAMPLE.COM',
  'mailto:jobs@example.com',
  'tel:+6781234567',
]

describe('safeHref', () => {
  it.each(unsafe)('rejects %s', (value) => {
    expect(safeHref(value)).toBeNull()
  })

  it.each(safe)('allows %s', (value) => {
    expect(safeHref(value)).toBe(value)
  })

  it('trims the value it returns', () => {
    expect(safeHref('  /jobs  ')).toBe('/jobs')
  })

  it('rejects values that are not strings', () => {
    expect(safeHref(null)).toBeNull()
    expect(safeHref(undefined)).toBeNull()
    expect(safeHref(42)).toBeNull()
  })
})
