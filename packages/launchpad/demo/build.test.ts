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

  it('builds the job listing and its sections as plain HTML with a GET filter form', () => {
    execFileSync(
      process.execPath,
      [astroBin, 'build', '--root', join(packageRoot, 'demo'), '--outDir', outDir],
      { cwd: packageRoot, stdio: 'pipe' },
    )

    const listing = readFileSync(join(outDir, 'jobs', 'index.html'), 'utf8')
    const category = readFileSync(join(outDir, 'jobs', 'category', 'hospitality', 'index.html'), 'utf8')
    const volunteer = readFileSync(join(outDir, 'jobs', 'type', 'voluntary', 'index.html'), 'utf8')

    // Filters are a GET form: the query string is the state, so no script is involved.
    expect(listing).toMatch(/<form[^>]*action="\/jobs"[^>]*method="get"/)
    expect(listing).toContain('name="q"')
    expect(listing).toContain('name="category"')
    expect(listing).toContain('name="type"')
    expect(listing).toContain('name="location"')
    expect(listing).toContain('name="voluntary"')
    expect(listing).not.toContain('astro-island')

    expect(category).toContain('Head Chef')
    expect(category).not.toContain('Booking Clerk')
    // The voluntary listing is its own section, and shows the voluntary job.
    expect(volunteer).toContain('Water Project Volunteer')
    expect(volunteer).not.toContain('Head Chef')

    // The default listing leaves voluntary jobs out, so the archive stays commercial.
    expect(listing).toContain('Head Chef')
    expect(listing).not.toContain('Water Project Volunteer')
    // Page 1 of a listing says how much it holds; a section says it in its own words.
    expect(listing).toContain('2 jobs')

    // A filtered page is a variant of a listing, so it is not indexed; the section itself is.
    expect(listing).not.toContain('noindex')
  }, 120_000)
})
