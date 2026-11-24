import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const example = readFileSync(resolve(__dirname, '../.dev.vars.example'), 'utf8')
const config = readFileSync(resolve(__dirname, './payload.config.ts'), 'utf8')

describe('.dev.vars.example documents the secrets the config reads @S-324', () => {
  it('lists TURNSTILE_SECRET_KEY, which form submission needs to verify a token', () => {
    expect(config).toContain('TURNSTILE_SECRET_KEY')
    expect(example).toMatch(/^# TURNSTILE_SECRET_KEY=$/m)
  })
})
