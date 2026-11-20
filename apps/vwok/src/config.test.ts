import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = join(import.meta.dirname, '..')

// Comments are stripped rather than parsed: wrangler's JSONC keeps the explanation next to the
// setting, and a JSON parser would reject it.
const readConfig = (file: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(appRoot, file), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1'),
  )

describe('Worker configuration', () => {
  it('deploys as mc-vwok with the compatibility date the CMS pins', () => {
    const config = readConfig('wrangler.jsonc')

    expect(config.name).toBe('mc-vwok')
    expect(config.compatibility_date).toBe('2026-10-01')
    // Payload's client and the CMS server code use Node built-ins.
    expect(config.compatibility_flags).toEqual(['nodejs_compat'])
  })

  it('leaves the entry point and assets to the adapter', () => {
    const config = readConfig('wrangler.jsonc')

    // @astrojs/cloudflare writes `main` and `assets.directory` into dist/server/wrangler.json.
    // A second, stale copy here would deploy the wrong entry point.
    expect(config).not.toHaveProperty('main')
    expect(config).not.toHaveProperty('assets')
  })

  it('serves the canonical Vanuatu Wok origin', () => {
    const config = readFileSync(join(appRoot, 'astro.config.mjs'), 'utf8')

    // The canonical link and the sitemap both come from `site`, so it must be the live origin.
    expect(/site:\s*['"]([^'"]+)['"]/.exec(config)?.[1]).toBe('https://vanuatuwok.vu')
    expect(config).toMatch(/output:\s*'server'/)
    // R2 serves the image variants (PJ-10); transforming in the Worker is billed per image.
    expect(config).toMatch(/imageService:\s*'passthrough'/)
    expect(config).toMatch(/session:\s*false/)
  })
})

describe('Lighthouse budget', () => {
  const config = readConfig('lighthouserc.json') as {
    ci: {
      assert: { assertions: Record<string, [string, { minScore?: number; maxNumericValue?: number }]> }
    }
  }

  it('holds every category at 0.98 or better', () => {
    for (const category of [
      'categories:performance',
      'categories:accessibility',
      'categories:best-practices',
      'categories:seo',
    ]) {
      expect(config.ci.assert.assertions[category]).toEqual(['error', { minScore: 0.98 }])
    }
  })

  it('keeps JavaScript under 50 KB', () => {
    expect(config.ci.assert.assertions['resource-summary:script:size']).toEqual([
      'error',
      { maxNumericValue: 51_200 },
    ])
  })
})
