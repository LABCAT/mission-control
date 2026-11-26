import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { turnstileSiteKey } from './env'

describe('the Turnstile site key (PJ-109, PJ-45)', () => {
  it('reads the Worker binding, trimmed, and leaves the widget out when it is empty @S-196', () => {
    expect(turnstileSiteKey({ PUBLIC_TURNSTILE_SITE_KEY: ' 0x4AAA ' })).toBe('0x4AAA')
    expect(turnstileSiteKey({ PUBLIC_TURNSTILE_SITE_KEY: '  ' })).toBeUndefined()
    expect(turnstileSiteKey({})).toBeUndefined()
  })

  it('is read through siteEnv() on every sign-in page, never from import.meta.env @S-196', () => {
    const dir = join(import.meta.dirname, 'pages/account/sign-in')
    const pages = readdirSync(dir).filter((file) => file.endsWith('.astro'))
    expect(pages.length).toBeGreaterThan(0)

    for (const page of pages) {
      expect(readFileSync(join(dir, page), 'utf8'), page).not.toContain('import.meta.env')
    }
    expect(readFileSync(join(dir, 'index.astro'), 'utf8')).toContain('turnstileSiteKey(await siteEnv())')
  })
})
