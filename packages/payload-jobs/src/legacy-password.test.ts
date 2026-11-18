import { describe, expect, it } from 'vitest'

import { legacyLoginHook, phpTrim, verifyLegacyWordPressHash } from './legacy-password'

// phpass vector: published in phpass 0.5 test.php (openwall.com/phpass).
const PHPASS = '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0'
const PHPASS_PW = 'test12345'

// Generated with PHP 8.3 `password_hash` mirroring WordPress 6.8
// `wp_hash_password()` (`$wp` + bcrypt of base64(hmac_sha384(trim(pw), 'wp-sha384'))), cost 4.
const WP68 = '$wp$2y$04$4L4AFjlulZFkqOkor1bmPerEAhPKuw4Zj1BHbPGtEI55hVZU8funG'
const WP68_PW = 'correct horse battery staple'
const WP68_PADDED = '$wp$2y$04$hDoqcl8Hz/i.1PQ3t11ki.tEnkg6SB71HYg1qVyRBiU2WHJKqMH0C' // pw: "spaced"

// Plain bcrypt from PHP 8.3 `password_hash(..., PASSWORD_BCRYPT, ['cost' => 4])`.
const BCRYPT = '$2y$04$l3Zz5aFjagJCAORvIYNlKeKd3AoRnISdqYp7eW0iHvTFxRuXQJNr2'

describe('verifyLegacyWordPressHash', () => {
  it.each([
    ['phpass $P$', PHPASS_PW, PHPASS],
    ['phpass $H$ prefix', PHPASS_PW, PHPASS.replace('$P$', '$H$')],
    ['WordPress 6.8 $wp$2y$', WP68_PW, WP68],
    ['plain bcrypt $2y$', WP68_PW, BCRYPT],
    ['plain bcrypt $2b$ prefix', WP68_PW, BCRYPT.replace('$2y$', '$2b$')],
  ])('accepts the right password for %s', async (_name, pw, hash) => {
    expect(await verifyLegacyWordPressHash(pw, hash)).toBe(true)
  })

  it.each([PHPASS, WP68, BCRYPT])('rejects a wrong password for %s', async (hash) => {
    expect(await verifyLegacyWordPressHash('wrong', hash)).toBe(false)
    expect(await verifyLegacyWordPressHash(`${PHPASS_PW} `, hash)).toBe(false)
  })

  it('trims surrounding whitespace for $wp$ hashes only, like WordPress 6.8', async () => {
    expect(await verifyLegacyWordPressHash('  spaced\n', WP68_PADDED)).toBe(true)
    expect(await verifyLegacyWordPressHash('spaced', WP68_PADDED)).toBe(true)
    expect(await verifyLegacyWordPressHash(` ${PHPASS_PW}`, PHPASS)).toBe(false)
  })

  it('keeps Unicode whitespace at the edges of a $wp$ password, like PHP trim()', async () => {
    // PHP 8.3: password "\u00A0pw\u00A0 " hashed as WordPress 6.8 does; trim() removes only the final space.
    const hash = '$wp$2y$04$RWmaCmrxGN4J/pulusjlj.txb.AtmMdrrhu5U6Ol1OxWTeAY6GC02'
    expect(await verifyLegacyWordPressHash('\u00A0pw\u00A0', hash)).toBe(true)
    expect(await verifyLegacyWordPressHash('\u00A0pw\u00A0 ', hash)).toBe(true)
    // JavaScript's trim() would reduce the correct password to "pw"; that must not match.
    expect(await verifyLegacyWordPressHash('pw', hash)).toBe(false)
  })

  it('handles non-ASCII passwords as UTF-8', async () => {
    // Different bytes must not collide: wrong accent fails.
    expect(await verifyLegacyWordPressHash('tést12345', PHPASS)).toBe(false)
  })

  it('rejects a phpass hash with a tampered salt, count or digest', async () => {
    expect(await verifyLegacyWordPressHash(PHPASS_PW, PHPASS.replace('IQRaTwm', 'IQRaTwn'))).toBe(false)
    expect(await verifyLegacyWordPressHash(PHPASS_PW, PHPASS.slice(0, -1) + 'M')).toBe(false)
    // Different iteration count means a different digest.
    expect(await verifyLegacyWordPressHash(PHPASS_PW, '$P$A' + PHPASS.slice(4))).toBe(false)
  })

  it.each([
    ['empty', ''],
    ['unknown scheme', '{SHA}abc'],
    ['bare md5', '5f4dcc3b5aa765d61d8327deb882cf99'],
    ['truncated phpass', PHPASS.slice(0, 20)],
    ['phpass with out-of-range count', `$P$!${PHPASS.slice(4)}`],
    ['phpass with excessive count', `$P$z${PHPASS.slice(4)}`],
    ['truncated bcrypt', BCRYPT.slice(0, 40)],
    ['bcrypt with illegal characters', BCRYPT.slice(0, 30) + '!!!' + BCRYPT.slice(33)],
    ['bcrypt cost above the cap', '$2y$31$' + BCRYPT.slice(7)],
    ['$wp with non-bcrypt payload', '$wp$nonsense'],
    ['$wp$ alone', '$wp$'],
  ])('returns false for %s without throwing', async (_name, hash) => {
    await expect(verifyLegacyWordPressHash(PHPASS_PW, hash)).resolves.toBe(false)
  })

  it('returns false for non-string or empty input', async () => {
    await expect(verifyLegacyWordPressHash('', PHPASS)).resolves.toBe(false)
    await expect(verifyLegacyWordPressHash(undefined as never, PHPASS)).resolves.toBe(false)
    await expect(verifyLegacyWordPressHash(PHPASS_PW, null as never)).resolves.toBe(false)
  })
})

describe('phpTrim', () => {
  it("strips exactly PHP's default characters from both ends", () => {
    expect(phpTrim(' \t\n\r\0\x0Bpw\x0B\0\r\n\t ')).toBe('pw')
    expect(phpTrim(' a b ')).toBe('a b')
  })

  it.each(['\u00A0', '\u2003', '\u3000', '\uFEFF', '\f'])(
    'leaves Unicode / other whitespace %j at the edges alone',
    (ws) => {
      expect(phpTrim(`${ws}pw${ws}`)).toBe(`${ws}pw${ws}`)
    },
  )
})

describe('legacyLoginHook', () => {
  it('skips users without a legacy hash', async () => {
    expect(await legacyLoginHook({ user: {}, password: 'x' })).toEqual({ status: 'skip' })
    expect(await legacyLoginHook({ user: { legacyPasswordHash: null }, password: 'x' })).toEqual({
      status: 'skip',
    })
  })

  it('on success sets the plaintext password to be rehashed and clears the legacy field', async () => {
    expect(
      await legacyLoginHook({ user: { legacyPasswordHash: PHPASS }, password: PHPASS_PW }),
    ).toEqual({
      status: 'verified',
      update: { password: PHPASS_PW, legacyPasswordHash: null },
    })
  })

  it('on a wrong password reports a failure that must count toward lockout, and changes nothing', async () => {
    const result = await legacyLoginHook({ user: { legacyPasswordHash: WP68 }, password: 'nope' })
    expect(result).toEqual({ status: 'failed', countFailedAttempt: true })
    expect('update' in result).toBe(false)
  })

  it('treats a malformed stored hash as a failed attempt, not an error', async () => {
    expect(await legacyLoginHook({ user: { legacyPasswordHash: 'garbage' }, password: 'x' })).toEqual({
      status: 'failed',
      countFailedAttempt: true,
    })
  })
})
