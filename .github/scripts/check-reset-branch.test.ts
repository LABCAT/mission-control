import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, 'check-reset-branch.sh')
let remote: string

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'reset-branch-'))
  const work = join(dir, 'work')
  remote = join(dir, 'remote.git')
  const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' })
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['init', '-q', work])
  git(work, 'config', 'user.email', 't@example.com')
  git(work, 'config', 'user.name', 't')
  git(work, 'commit', '-q', '--allow-empty', '-m', 'x')
  for (const b of ['main', 'feature/foo', 'pj-90']) git(work, 'push', '-q', remote, `HEAD:refs/heads/${b}`)
})

const run = (branch: string) => {
  try {
    execFileSync(script, [branch], { env: { ...process.env, REMOTE: remote }, stdio: 'pipe' })
    return 0
  } catch (e: any) {
    return e.status as number
  }
}

describe('check-reset-branch.sh', () => {
  it('accepts real git branches, including ones with a slash', () => {
    expect(run('feature/foo')).toBe(0)
    expect(run('pj-90')).toBe(0)
  })
  it('rejects the preview name of an existing branch (feature-foo for feature/foo)', () => {
    expect(run('feature-foo')).not.toBe(0)
  })
  it('rejects branches that do not exist', () => {
    expect(run('nope')).not.toBe(0)
  })
  it.each(['', 'main', 'preview/feature-foo', 'refs/heads/pj-90', '-x', 'a b', 'a..b'])('rejects %j', (b) => {
    expect(run(b)).not.toBe(0)
  })
})
