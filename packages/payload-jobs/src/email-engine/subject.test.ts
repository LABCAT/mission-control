import { describe, expect, it } from 'vitest'

import { insertVariable } from './subject'

describe('insertVariable @S-181', () => {
  it('adds the token with a space before it', () => {
    expect(insertVariable('Welcome', 'firstName')).toBe('Welcome {{firstName}}')
    expect(insertVariable('Welcome ', 'firstName')).toBe('Welcome {{firstName}}')
    expect(insertVariable('', 'jobTitle')).toBe('{{jobTitle}}')
    expect(insertVariable(null, 'jobTitle')).toBe('{{jobTitle}}')
  })
})
