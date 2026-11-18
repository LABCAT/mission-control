import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { compare } from 'bcryptjs'

/**
 * Verifier for imported WordPress password hashes (PJ-34).
 *
 * Needs `node:crypto` (MD5 and HMAC-SHA384 for phpass / `$wp$`), which Workers
 * provides through the `nodejs_compat` flag set in `apps/cms/wrangler.jsonc`.
 *
 * Supported formats:
 * - phpass portable `$P$` / `$H$` (WordPress < 6.8, and every hash on old sites)
 * - WordPress 6.8+ `$wp$2y$..`: bcrypt over base64(HMAC-SHA384(trim(password), "wp-sha384")).
 *   Source: WordPress 6.8.0 `wp-includes/pluggable.php`, `wp_check_password()` /
 *   `wp_hash_password()`; the `$wp` prefix is stripped before `password_verify`.
 * - plain bcrypt `$2y$` / `$2a$` / `$2b$`
 *
 * Anything else, or anything malformed, returns false. These functions never throw.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// WordPress uses 2^13 phpass rounds and bcrypt cost 10. The caps stop a crafted
// hash from pinning a Worker's CPU; they sit far above anything WordPress writes.
const MAX_PHPASS_LOG2 = 20
const MAX_BCRYPT_COST = 15

const BCRYPT_RE = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** phpass's own base64 variant, little-endian bit order. */
function encode64(input: Buffer, count: number): string {
  let output = ''
  let i = 0
  do {
    let value = input[i++]!
    output += ITOA64[value & 0x3f]
    if (i < count) value |= input[i]! << 8
    output += ITOA64[(value >> 6) & 0x3f]
    if (i++ >= count) break
    if (i < count) value |= input[i]! << 16
    output += ITOA64[(value >> 12) & 0x3f]
    if (i++ >= count) break
    output += ITOA64[(value >> 18) & 0x3f]
  } while (i < count)
  return output
}

function verifyPhpass(password: string, hash: string): boolean {
  if (hash.length !== 34) return false
  const log2 = ITOA64.indexOf(hash[3]!)
  if (log2 < 7 || log2 > MAX_PHPASS_LOG2) return false

  const salt = hash.slice(4, 12)
  const pw = Buffer.from(password, 'utf8')
  let digest: Buffer = createHash('md5').update(salt).update(pw).digest()
  for (let i = 0, rounds = 2 ** log2; i < rounds; i++) {
    digest = createHash('md5').update(digest).update(pw).digest()
  }
  return safeEqual(hash.slice(0, 12) + encode64(digest, 16), hash)
}

async function verifyBcrypt(password: string, hash: string): Promise<boolean> {
  const match = BCRYPT_RE.exec(hash)
  if (!match || Number(match[1]) > MAX_BCRYPT_COST) return false
  // bcryptjs verifies `$2y$` hashes the same as `$2b$`.
  return compare(password, hash)
}

export async function verifyLegacyWordPressHash(
  password: string,
  hash: string,
): Promise<boolean> {
  try {
    if (typeof password !== 'string' || typeof hash !== 'string' || !password || !hash) {
      return false
    }
    if (hash.startsWith('$P$') || hash.startsWith('$H$')) return verifyPhpass(password, hash)
    if (hash.startsWith('$wp$')) {
      const prehash = createHmac('sha384', 'wp-sha384').update(password.trim()).digest('base64')
      return await verifyBcrypt(prehash, hash.slice(3))
    }
    return await verifyBcrypt(password, hash)
  } catch {
    return false
  }
}

export type LegacyLoginResult =
  /** No legacy hash on this user: let Payload's normal login run. */
  | { status: 'skip' }
  /** Password matched: save `update` on the user (Payload hashes `password` itself). */
  | { status: 'verified'; update: { password: string; legacyPasswordHash: null } }
  /** Wrong password: the caller must count it toward Payload's lockout. */
  | { status: 'failed'; countFailedAttempt: true }

/**
 * Pure helper for a login hook. Does no I/O: the caller applies `update` and
 * increments `loginAttempts` on `failed`.
 */
export async function legacyLoginHook(args: {
  user: { legacyPasswordHash?: string | null }
  password: string
}): Promise<LegacyLoginResult> {
  const { legacyPasswordHash } = args.user
  if (!legacyPasswordHash) return { status: 'skip' }
  if (await verifyLegacyWordPressHash(args.password, legacyPasswordHash)) {
    return {
      status: 'verified',
      update: { password: args.password, legacyPasswordHash: null },
    }
  }
  return { status: 'failed', countFailedAttempt: true }
}
