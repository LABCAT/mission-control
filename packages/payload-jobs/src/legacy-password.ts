import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

import { compare } from 'bcryptjs'
import type {
  CollectionBeforeOperationHook,
  CollectionBeforeValidateHook,
  CollectionConfig,
  Field,
} from 'payload'

/**
 * Verifier for imported WordPress password hashes (PJ-34).
 *
 * Needs `node:crypto` (MD5 and HMAC-SHA384 for phpass / `$wp$`), which Workers
 * provides through the `nodejs_compat` flag set in `apps/cms/wrangler.jsonc`.
 *
 * Supported formats:
 * - phpass portable `$P$` / `$H$` (WordPress < 6.8, and every hash on old sites)
 * - WordPress 6.8+ `$wp$2y$..`: bcrypt over base64(HMAC-SHA384(php_trim(password), "wp-sha384")).
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

/**
 * PHP's default `trim()`: only space, \t, \n, \r, NUL and \x0B. JavaScript's `trim()` also
 * strips Unicode whitespace (e.g. U+00A0), which would reject valid WordPress passwords.
 */
const PHP_TRIM_CHARS = ' \t\n\r\0\x0B'
export const phpTrim = (value: string): string => {
  let start = 0
  let end = value.length
  while (start < end && PHP_TRIM_CHARS.includes(value[start]!)) start++
  while (end > start && PHP_TRIM_CHARS.includes(value[end - 1]!)) end--
  return value.slice(start, end)
}

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
      const prehash = createHmac('sha384', 'wp-sha384').update(phpTrim(password)).digest('base64')
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

export const LEGACY_PASSWORD_FIELD = 'legacyPasswordHash'

/** Internal-only: never readable or writable through the API; set by the importer. */
export const legacyPasswordHashField: Field = {
  name: LEGACY_PASSWORD_FIELD,
  type: 'text',
  access: { create: () => false, read: () => false, update: () => false },
  admin: { hidden: true },
  index: false,
}

/**
 * Runs *before* Payload's own login check (Payload's `beforeLogin` runs after it, so it could
 * never accept a user who has no Payload hash yet). If the user still has a legacy hash and the
 * password matches it, the password is saved through Payload (rehash) and the legacy hash is
 * cleared, so the normal login that follows succeeds.
 *
 * A wrong password changes nothing: the user has no Payload hash, so Payload's own check fails
 * and increments `loginAttempts`, which is what drives lockout. Locked users are skipped.
 */
export const legacyBeforeLoginOperation: CollectionBeforeOperationHook = async ({
  args,
  operation,
}) => {
  if (operation !== 'login') return args
  const { collection, data, req } = args as {
    collection: { config: { slug: string } }
    data?: { email?: unknown; password?: unknown }
    req: import('payload').PayloadRequest
  }
  if (typeof data?.email !== 'string' || typeof data.password !== 'string') return args

  const slug = collection.config.slug
  const { docs } = await req.payload.find({
    collection: slug as never,
    where: { email: { equals: data.email.trim().toLowerCase() } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    pagination: false,
  })
  const user = docs[0] as
    | {
        id: number | string
        hash?: string | null
        lockUntil?: string | null
        legacyPasswordHash?: string | null
        salt?: string | null
      }
    | undefined
  if (!user) return args
  // The legacy hash is only for users who have no usable Payload password yet. Once one exists
  // (set, changed or reset) a stale WordPress hash must never overwrite it.
  if (typeof user.hash === 'string' && user.hash && typeof user.salt === 'string' && user.salt) {
    return args
  }
  if (user.lockUntil && new Date(user.lockUntil).getTime() > Date.now()) return args

  const result = await legacyLoginHook({ user, password: data.password })
  if (result.status === 'verified') {
    await req.payload.update({
      collection: slug as never,
      id: user.id,
      data: result.update as never,
      overrideAccess: true,
    })
  }
  return args
}

/**
 * Whenever a Payload password is set, changed or reset, the WordPress hash is dead.
 * `password` is present on create/update through the API; the reset-password flow instead
 * hands the hook the user row with the new `hash`/`salt` already generated and persists
 * that same object, so mutating `data` there is what clears the column.
 */
export const clearLegacyHashOnPasswordSet: CollectionBeforeValidateHook = ({ data, operation }) => {
  if (!data) return data
  const passwordSet = typeof data.password === 'string' && data.password.length > 0
  const resetHashed =
    operation === 'update' && typeof data.hash === 'string' && typeof data.salt === 'string'
  if (passwordSet || resetHashed) data[LEGACY_PASSWORD_FIELD] = null
  return data
}

/** The WordPress user id of an imported user, so a re-run of the import updates instead of duplicating. */
export const legacyUserIdField: Field = {
  name: 'legacyId',
  type: 'number',
  index: true,
  access: { create: () => false, update: () => false },
  admin: { hidden: true, position: 'sidebar' },
}

/** Adds the legacy hash and id fields and the login hook to an auth collection. */
export const withLegacyPasswords = (collection: CollectionConfig): CollectionConfig => ({
  ...collection,
  fields: [...collection.fields, legacyPasswordHashField, legacyUserIdField],
  hooks: {
    ...collection.hooks,
    beforeValidate: [...(collection.hooks?.beforeValidate ?? []), clearLegacyHashOnPasswordSet],
    beforeOperation: [...(collection.hooks?.beforeOperation ?? []), legacyBeforeLoginOperation],
  },
})
