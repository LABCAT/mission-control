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

/** The viewed-jobs feature is the only client JavaScript this budget covers. */
const JS_BUDGET_GZIP = 1500

/** Astro's output files for the viewed-jobs components and their shared module. */
const VIEWED_JOBS_SCRIPT = /^(?:JobCard|RecentlyViewed|JobViewTracker)\.|^idle\./

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

  it('builds the job listing and its sections as plain HTML with a GET filter form', () => {
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
  })

  it('keeps the viewed-jobs JavaScript under 1.5 KB min+gzip', () => {
    const assets = join(outDir, '_astro')
    // Measure only this feature's scripts: the demo may ship other client code later.
    const scripts = readdirSync(assets).filter(
      (name) => name.endsWith('.js') && VIEWED_JOBS_SCRIPT.test(name),
    )

    const raw = scripts.reduce((total, name) => total + statSync(join(assets, name)).size, 0)
    const gzipped = scripts.reduce(
      (total, name) => total + gzipSync(readFileSync(join(assets, name))).byteLength,
      0,
    )

    console.log(`viewed-jobs JavaScript: ${raw} B min, ${gzipped} B min+gzip`)

    expect(scripts.length).toBeGreaterThan(0)
    expect(gzipped).toBeLessThan(JS_BUDGET_GZIP)
  })
  it('builds a live job page with JobPosting data, share tags and the counting script @S-280 @S-284 @S-285', () => {
    const html = readFileSync(join(outDir, 'jobs', 'head-chef', 'index.html'), 'utf8')

    expect(html).toContain('<h1')
    expect(html).toContain('application/ld+json')
    expect(html).toContain('"@type":"JobPosting"')
    expect(html).not.toContain('noindex')
    expect(html).toContain('property="og:image"')
    expect(html).toContain('/og/jobs/head-chef.png')
    // Every live view is counted, whether or not the tenant shows the number.
    expect(html).toMatch(/<p[^>]*data-job-views/)
  })

  it('builds a closed job as a noindex page with no JobPosting and no apply button @S-282', () => {
    const html = readFileSync(join(outDir, 'jobs', 'sous-chef', 'index.html'), 'utf8')

    expect(html).toContain('No longer accepting applications')
    expect(html).toContain('noindex')
    expect(html).not.toContain('JobPosting')
    expect(html).not.toMatch(/<p[^>]*data-job-views/)
  })

  it('ships no client JavaScript on a job page beyond the view beacon, under 1 KB min+gzip @S-289', () => {
    const html = readFileSync(join(outDir, 'jobs', 'head-chef', 'index.html'), 'utf8')
    const assets = join(outDir, '_astro')
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]!)
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1]!)
      // The view-as banner's inline cookie check is the layout's, not this page's.
      .filter((code) => !code.includes('mc-view-as'))

    const files = sources.map((src) => join(assets, src.split('/').pop()!))
    const bytes = [
      ...files.map((file) => gzipSync(readFileSync(file)).byteLength),
      ...inline.map((code) => gzipSync(code).byteLength),
    ]
    const total = bytes.reduce((sum, size) => sum + size, 0)

    console.log(`job page JavaScript: ${total} B min+gzip across ${bytes.length} scripts`)

    // Only the beacon: nothing is hydrated, and every script file belongs to it.
    expect(html).not.toContain('astro-island')
    expect(total).toBeLessThan(1024)
    for (const file of files) expect(readFileSync(file, 'utf8')).toContain('data-job-views')
  })
})
