import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, 'delete-preview.sh')

// Stubs for gh and npx (wrangler, neonctl) that log every call.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'delete-preview-'))
  const bin = join(dir, 'bin')
  execFileSync('mkdir', [bin])
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  stub('gh', 'echo "gh $*" >> "$LOG"; [ "${GH_RC:-0}" = 0 ] || exit 1; echo "$PRS"')
  stub('npx', `echo "npx $*" >> "$LOG"
case "$2" in
  wrangler*) exit 0 ;;
  neonctl*) [[ "$*" == *"branches list"* ]] && echo '[{"name":"main"},{"name":"preview/feature-foo"}]'; exit 0 ;;
esac`)
  const run = (name: string, env: Record<string, string>) => {
    const log = join(dir, 'log')
    let code = 0
    try {
      execFileSync(script, [name], {
        env: { PATH: `${bin}:${process.env.PATH}`, LOG: log, WRANGLER: 'wrangler@1', NEONCTL: 'neonctl@1', WORKER_NAME: 'w', PROJECT: 'p', NEON_API_KEY: 'k', ...env },
        stdio: 'pipe',
      })
    } catch (e: any) {
      code = e.status
    }
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : ''
    return { code, calls, deleted: /branches delete/.test(calls), touchedWorker: /wrangler/.test(calls) }
  }
  return run
}

const pr = (headRefName: string, isCrossRepository = false) => ({ headRefName, isCrossRepository })

describe('delete-preview.sh re-check before deleting', () => {
  it('deletes when no open PR uses the name', () => {
    const r = setup()('feature-foo', { PRS: JSON.stringify([pr('other')]) })
    expect(r.code).toBe(0)
    expect(r.deleted).toBe(true)
  })
  it('skips everything when a PR opened since the sweep listed it', () => {
    const r = setup()('feature-foo', { PRS: JSON.stringify([pr('feature/foo')]) })
    expect(r.code).toBe(0)
    expect(r.deleted).toBe(false)
    expect(r.touchedWorker).toBe(false)
  })
  it('ALLOW_LIVE=true deletes even when a PR uses the name, without asking gh', () => {
    const r = setup()('feature-foo', { PRS: JSON.stringify([pr('feature/foo')]), ALLOW_LIVE: 'true' })
    expect(r.code).toBe(0)
    expect(r.deleted).toBe(true)
    expect(r.calls).not.toContain('gh ')
  })
  it.each(['rc-0-2-0', 'main/x'])('ALLOW_LIVE=true still refuses %s', (name) => {
    const r = setup()(name, { PRS: '[]', ALLOW_LIVE: 'true' })
    expect(r.deleted).toBe(false)
    expect(r.touchedWorker).toBe(false)
  })
  it('fails and deletes nothing when the PR list cannot be fetched', () => {
    const r = setup()('feature-foo', { PRS: '[]', GH_RC: '1' })
    expect(r.code).not.toBe(0)
    expect(r.deleted).toBe(false)
    expect(r.touchedWorker).toBe(false)
  })
  it('fails and deletes nothing when the PR list is not JSON', () => {
    const r = setup()('feature-foo', { PRS: 'oops' })
    expect(r.code).not.toBe(0)
    expect(r.deleted).toBe(false)
  })
  it.each(['rc-0-2-0', 'rc-foo'])('refuses RC preview %s before any delete or even listing PRs', (name) => {
    const r = setup()(name, { PRS: '[]' })
    expect(r.code).toBe(0)
    expect(r.deleted).toBe(false)
    expect(r.touchedWorker).toBe(false)
    expect(r.calls).toBe('')
  })
  it('refuses the preview name of git branch rc/0.2.0', () => {
    const name = execFileSync(join(import.meta.dirname, 'preview-name.sh'), ['branch', 'rc/0.2.0'], { encoding: 'utf8' }).trim()
    expect(name).toBe('rc-0-2-0')
    const r = setup()(name, { PRS: '[]' })
    expect(r.deleted).toBe(false)
    expect(r.touchedWorker).toBe(false)
  })
  it('refuses a name that is not a preview branch', () => {
    const r = setup()('main/x', { PRS: '[]' })
    expect(r.code).not.toBe(0)
    expect(r.deleted).toBe(false)
  })
})
