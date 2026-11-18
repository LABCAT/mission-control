import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const astroBin = join(dirname(require.resolve('astro/package.json')), 'bin', 'astro.mjs')
// Astro renames files from `.astro/` into the output directory, which fails across devices,
// so the temporary output lives beside the package rather than in the system temp dir.
const outDir = mkdtempSync(join(packageRoot, '.demo-build-'))

afterAll(() => rmSync(outDir, { force: true, recursive: true }))

/**
 * The demo is the theme's build check: if a component, a Rocketship import or the styles
 * entry breaks, this fails. It renders one page with no data source, so it stays cheap.
 */
describe('demo site', () => {
  it('builds a static page with the tenant tokens applied', () => {
    execFileSync(
      process.execPath,
      [astroBin, 'build', '--root', join(packageRoot, 'demo'), '--outDir', outDir],
      { cwd: packageRoot, stdio: 'pipe' },
    )

    const html = readFileSync(join(outDir, 'index.html'), 'utf8')

    expect(html).toContain('<html lang="en"')
    expect(html).toContain('--rs-color-accent: #06914b')
    expect(html).toContain('rs-card')
    expect(html).toContain('name="cf-turnstile-response"')
    // No page ships framework JavaScript: the only script is the Turnstile island.
    expect(html).not.toContain('astro-island')
  }, 120_000)
})
