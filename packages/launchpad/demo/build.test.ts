import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const astroBin = join(dirname(require.resolve('astro/package.json')), 'bin', 'astro.mjs')
// Astro renames files from `.astro/` into the output directory, which fails across devices,
// so the temporary output lives beside the package rather than in the system temp dir.
const outDir = mkdtempSync(join(packageRoot, '.demo-build-'))

/** The viewed-jobs feature is the demo's only client JavaScript. Keep it this small. */
const JS_BUDGET_GZIP = 1500

beforeAll(() => {
  execFileSync(
    process.execPath,
    [astroBin, 'build', '--root', join(packageRoot, 'demo'), '--outDir', outDir],
    { cwd: packageRoot, stdio: 'pipe' },
  )
}, 120_000)

afterAll(() => rmSync(outDir, { force: true, recursive: true }))

/**
 * The demo is the theme's build check: if a component, a Rocketship import or the styles
 * entry breaks, this fails. It renders one page with no data source, so it stays cheap.
 */
describe('demo site', () => {
  it('builds a static page with the tenant tokens applied', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')

    expect(html).toContain('<html lang="en"')
    expect(html).toContain('--rs-color-accent: #06914b')
    expect(html).toContain('rs-card')
    expect(html).toContain('name="cf-turnstile-response"')
    expect(html).toContain('data-job-id="1"')
    expect(html).toContain('data-viewed-label')
    expect(html).toContain('data-recently-viewed')
    // No page ships framework JavaScript: the only script is the Turnstile island.
    expect(html).not.toContain('astro-island')
  })

  it('keeps the viewed-jobs JavaScript under 1.5 KB min+gzip', () => {
    const assets = join(outDir, '_astro')
    const scripts = readdirSync(assets).filter((name) => name.endsWith('.js'))

    const raw = scripts.reduce((total, name) => total + statSync(join(assets, name)).size, 0)
    const gzipped = scripts.reduce(
      (total, name) => total + gzipSync(readFileSync(join(assets, name))).byteLength,
      0,
    )

    console.log(`viewed-jobs JavaScript: ${raw} B min, ${gzipped} B min+gzip`)

    expect(scripts.length).toBeGreaterThan(0)
    expect(gzipped).toBeLessThan(JS_BUDGET_GZIP)
  })
})
