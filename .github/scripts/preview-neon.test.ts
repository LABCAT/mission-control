import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script, no types
import { capacityProblem, isPreviewBranch, previewName, previewStillUsed, staleBranches } from './preview-neon.mjs'

const here = import.meta.dirname
const b = (name: string, extra = {}) => ({ name, ...extra })
const pr = (headRefName: string, isCrossRepository = false) => ({ headRefName, isCrossRepository })

describe('isPreviewBranch', () => {
  it('accepts preview/<dns label>', () => {
    for (const n of ['preview/pj-86', 'preview/a', 'preview/rc-0-2-0', `preview/${'a'.repeat(40)}`]) {
      expect(isPreviewBranch(n), n).toBe(true)
    }
  })
  it('rejects everything else', () => {
    const bad = [
      'main', 'production', 'preview', 'preview/', 'preview/main/x', 'Preview/x', 'preview/X', 'preview/-x', 'preview/x-',
      'preview/x y', 'preview/x_y', 'preview/x.y', 'preview//x', 'xpreview/x', ' preview/x', 'preview/x\n', 'preview/../main',
      `preview/${'a'.repeat(41)}`, 'preview/*', '', null, undefined, 42,
    ]
    for (const n of bad) expect(isPreviewBranch(n), String(n)).toBe(false)
  })
})

describe('previewName', () => {
  const cases = ['feature/Foo_bar', 'PJ-86-Preview', '--weird--', 'a'.repeat(60), `${'a'.repeat(39)}/b`, 'x//y', 'ünï/cödé']
  it.each(cases)('matches preview-name.sh for %s', (branch) => {
    const sh = execFileSync(join(here, 'preview-name.sh'), ['branch', branch], { encoding: 'utf8' }).trim()
    expect(previewName(branch)).toBe(sh)
  })
  it('always yields a name isPreviewBranch accepts', () => {
    for (const c of cases) if (previewName(c)) expect(isPreviewBranch(`preview/${previewName(c)}`)).toBe(true)
  })
})

describe('staleBranches', () => {
  const main = b('main', { primary: true })
  it('keeps previews of open PRs, deletes the rest', () => {
    const out = staleBranches([main, b('preview/pj-1'), b('preview/pj-2'), b('preview/feature-foo')], [pr('PJ-1'), pr('feature/Foo')])
    expect(out).toEqual(['preview/pj-2'])
  })
  it('never returns main or non-preview branches', () => {
    const out = staleBranches([main, b('develop'), b('production'), b('preview'), b('previews/x'), b('preview/ok')], [])
    expect(out).toEqual(['preview/ok'])
  })
  it('never returns RC previews', () => {
    expect(staleBranches([main, b('preview/rc-0-2-0'), b('preview/old')], [])).toEqual(['preview/old'])
  })
  it('honours primary/default/protected flags even on a preview-shaped name', () => {
    const out = staleBranches([main, b('preview/a', { primary: true }), b('preview/b', { default: true }), b('preview/c', { protected: true }), b('preview/d')], [])
    expect(out).toEqual(['preview/d'])
  })
  it('ignores fork PRs when deciding what is live', () => {
    expect(staleBranches([main, b('preview/pj-1')], [pr('pj-1', true)])).toEqual(['preview/pj-1'])
  })
  it('refuses an incomplete listing or bad input', () => {
    expect(() => staleBranches([b('preview/a')], [])).toThrow(/main/)
    expect(() => staleBranches({}, [])).toThrow()
    expect(() => staleBranches([main], null)).toThrow()
    expect(() => staleBranches([main, { id: 1 }], [])).toThrow()
  })
})

describe('previewStillUsed', () => {
  it('is true when another open PR normalizes to the same name', () => {
    expect(previewStillUsed('feature/foo', [pr('feature-foo')])).toBe(true)
    expect(previewStillUsed('Feature_Foo', [pr('feature/foo')])).toBe(true)
  })
  it('is true for another open PR on the very same branch', () => {
    expect(previewStillUsed('feature/foo', [pr('feature/foo')])).toBe(true)
  })
  it('is false with no match, an empty list, or only fork PRs', () => {
    expect(previewStillUsed('feature/foo', [pr('feature/bar')])).toBe(false)
    expect(previewStillUsed('feature/foo', [])).toBe(false)
    expect(previewStillUsed('feature/foo', [pr('feature-foo', true)])).toBe(false)
  })
  it('throws on a bad list so the caller fails instead of deleting', () => {
    expect(() => previewStillUsed('x', null)).toThrow()
  })
})

describe('capacityProblem', () => {
  const list = [b('main'), b('preview/a'), b('preview/b'), b('other')]
  it('is fine under the limit or when the branch already exists', () => {
    expect(capacityProblem(list, 5, 'preview/c')).toBeNull()
    expect(capacityProblem(list, 4, 'preview/a')).toBeNull()
  })
  it('lists preview/* branches when full', () => {
    const msg = capacityProblem(list, 4, 'preview/c')
    expect(msg).toContain('4/4')
    expect(msg).toContain('- preview/a')
    expect(msg).toContain('- preview/b')
    expect(msg).not.toContain('- main')
  })
})

describe('cli', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preview-neon-'))
  const write = (n: string, v: unknown) => (writeFileSync(join(dir, n), JSON.stringify(v)), join(dir, n))
  const run = (...a: string[]) => {
    try {
      return { code: 0, out: execFileSync('node', [join(here, 'preview-neon.mjs'), ...a], { encoding: 'utf8', stdio: 'pipe' }) }
    } catch (e: any) {
      return { code: e.status as number, out: String(e.stderr) }
    }
  }
  it('stale prints names', () => {
    const r = run('stale', write('b.json', [b('main'), b('preview/x'), b('preview/y')]), write('p.json', [pr('y')]))
    expect(r).toEqual({ code: 0, out: 'preview/x\n' })
  })
  it('stale fails closed on bad input', () => {
    expect(run('stale', write('b2.json', []), write('p2.json', [])).code).toBe(2)
  })
  it('live exits 0 when used, 1 when not, 2 on bad input', () => {
    const prs = write('p4.json', [pr('feature-foo')])
    expect(run('live', 'feature/foo', prs).code).toBe(0)
    expect(run('live', 'other', prs).code).toBe(1)
    expect(run('live', 'x', write('p5.json', {})).code).toBe(2)
  })
  it('deletable: 0 for a normal preview, 3 for RC, 1 for anything else', () => {
    expect(run('deletable', 'preview/pj-1').code).toBe(0)
    expect(run('deletable', 'preview/rc-0-2-0').code).toBe(3)
    expect(run('deletable', 'main').code).toBe(1)
  })
  it('capacity exits 1 with the list', () => {
    const r = run('capacity', write('b3.json', [b('main'), b('preview/x')]), '2', 'preview/new')
    expect(r.code).toBe(1)
    expect(r.out).toContain('preview/x')
  })
})
