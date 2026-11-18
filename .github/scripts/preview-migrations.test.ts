import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { migrationNamesIn, unknownApplied } from './preview-migrations.mjs'

const script = join(import.meta.dirname, 'preview-migrations.mjs')

describe('migrationNamesIn', () => {
  it('keeps .ts migrations and drops index.ts and .json', () => {
    expect(migrationNamesIn(['a.json', 'a.ts', 'b.ts', 'index.ts'])).toEqual(['a', 'b'])
  })
})

describe('unknownApplied', () => {
  const branch = ['20261105_initial', '20261118_064410_locations']
  it('is empty when everything applied is in the branch', () => {
    expect(unknownApplied({ applied: ['20261105_initial'], branch })).toEqual([])
  })
  it('finds a migration the PR re-created under a new name (PJ-90)', () => {
    expect(unknownApplied({ applied: ['20261105_initial', '20261114_115130_locations'], branch })).toEqual(['20261114_115130_locations'])
  })
  it('accepts migrations that exist on main but not in an older PR branch', () => {
    expect(unknownApplied({ applied: ['20261105_initial', '20261120_new_on_main'], branch, main: ['20261120_new_on_main'] })).toEqual([])
  })
  it('ignores the dev row', () => {
    expect(unknownApplied({ applied: ['dev', '20261105_initial'], branch })).toEqual([])
  })
})

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-migrations-'))
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations)
  for (const f of ['20261105_initial.ts', '20261105_initial.json', '20261118_064410_locations.ts', 'index.ts']) writeFileSync(join(migrations, f), '')
  const file = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name))
  const run = (...a: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [script, ...a], { encoding: 'utf8', stdio: 'pipe' }).trim() }
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stderr) }
    }
  }
  it('prints keep', () => {
    expect(run('decide', file('a1', '20261105_initial\n'), migrations)).toEqual({ code: 0, out: 'keep' })
  })
  it('keep for an empty applied list (fresh database)', () => {
    expect(run('decide', file('a2', ''), migrations).out).toBe('keep')
  })
  it('prints reset for the PJ-90 case', () => {
    expect(run('decide', file('a3', '20261105_initial\n20261114_115130_locations\n'), migrations).out).toBe('reset')
  })
  it('keeps names that main has', () => {
    expect(run('decide', file('a4', '20261120_x\n'), migrations, file('m', '20261120_x\n')).out).toBe('keep')
  })
  it('fails closed on a wrong directory, so it never resets on bad input', () => {
    expect(run('decide', file('a5', 'x\n'), join(dir, 'missing')).code).toBe(2)
    expect(run('decide', file('a6', 'x\n'), dir).code).toBe(2)
  })
})
