/**
 * Encrypted Xero tokens at rest, and access-token refresh.
 *
 * Tokens live on the tenant's `xero-settings` row, encrypted with AES-GCM (see `crypto.ts`)
 * and bound to that row's ID, so a token copied onto another tenant's row cannot be read.
 * The fields are hidden and refuse access through the API, so tokens only ever leave through
 * this module.
 *
 * Xero rotates the refresh token on every refresh: the old one stops working as soon as Xero
 * answers. Every refresh is therefore written straight back to the settings row.
 *
 * That rotation makes concurrent refreshes dangerous: two requests holding the same expired
 * access token would both spend the same refresh token, and the slower one would be refused
 * with the token the faster one already retired. Refresh is therefore single-flight per
 * settings row. A request takes the row's short lease with one conditional `UPDATE` that also
 * compares the refresh token it is about to spend, so exactly one request calls Xero; the
 * others wait for that request to save and then read its tokens. The lease expires on its own,
 * so a request that dies mid-refresh never blocks the next one.
 */

import { createPayloadRequest, docAccessOperation, type Payload } from 'payload'

import { decryptToken, encryptToken, XERO_TOKEN_KEY_ENV } from './crypto'
import {
  refreshAccessToken,
  type XeroOAuthOptions,
  XeroOAuthError,
  type XeroTokenSet,
  XERO_REFRESH_MARGIN_MS,
} from './oauth'

/** How long one request may hold the refresh lease before another may take it over. */
export const XERO_REFRESH_LEASE_MS = 10_000
/** How often a waiting request re-reads the row. */
const REFRESH_POLL_MS = 100
/** Added to the lease when waiting, so a wait outlives the holder rather than the holder's peer. */
const REFRESH_WAIT_SLACK_MS = 1_000

export type XeroStoredTokens = {
  /** Encrypted access token. */
  accessToken?: null | string
  /** ISO timestamp of the access token's expiry. */
  expiresAt?: null | string
  /** Identifies the request holding the refresh lease; null when nobody does. */
  refreshLockToken?: null | string
  /** Epoch milliseconds after which the refresh lease may be taken over. */
  refreshLockedUntil?: null | number
  /** Encrypted refresh token. */
  refreshToken?: null | string
  /** Scopes Xero granted, space separated. */
  scope?: null | string
}

export type XeroSettingsDoc = {
  id: number | string
  tenant?: unknown
  tokens?: null | XeroStoredTokens
  xeroTenantId?: null | string
  [key: string]: unknown
}

/** Authenticated data for the token cipher: one settings row, nothing else. */
export const tokenContext = (settingsID: number | string): string => `xero-settings:${settingsID}`

/**
 * The token cipher key: the option (a value or a getter, as other options accept), or the
 * `XERO_TOKEN_ENCRYPTION_KEY` env var. Read lazily so Workers env works.
 */
const requireKey = (key: XeroOAuthOptions['encryptionKey']): string => {
  const resolved =
    (typeof key === 'function' ? key() : key) ??
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      XERO_TOKEN_KEY_ENV
    ]

  if (!resolved) {
    throw new XeroOAuthError(
      'not_configured',
      `Xero tokens are encrypted with ${XERO_TOKEN_KEY_ENV}. Set it in the environment.`,
    )
  }

  return resolved
}

export type SaveTokensArgs = {
  /** Settings collection slug. */
  collection: string
  /** Other columns to write in the same update, e.g. `connectedAt`. */
  data?: Record<string, unknown>
  encryptionKey?: XeroOAuthOptions['encryptionKey']
  payload: Payload
  /** The settings row the tokens belong to. */
  settings: XeroSettingsDoc
  tokens: XeroTokenSet
}

/** The encrypted columns for a token set, as the `tokens` group stores them. */
const encryptedTokenColumns = async (
  tokens: XeroTokenSet,
  key: string,
  context: string,
): Promise<XeroStoredTokens> => ({
  accessToken: await encryptToken(tokens.accessToken, key, context),
  expiresAt: tokens.expiresAt,
  // A completed write ends any refresh lease this row carried.
  refreshLockToken: null,
  refreshLockedUntil: null,
  refreshToken: tokens.refreshToken ? await encryptToken(tokens.refreshToken, key, context) : null,
  scope: tokens.scope,
})

/**
 * Refuse a privileged token write when the app says this user may not update the row.
 *
 * `saveXeroTokens` writes with `overrideAccess: true`, because the `tokens` group refuses
 * `update` through the API by design. Without this check a user who may only *read* a row
 * could still replace its connection, since reading the row is all the endpoints do before
 * saving. Payload's own document permissions run every access rule for every operation,
 * including the tenancy layer's `where` constraints, against this exact row.
 */
export const assertCanUpdateSettings = async ({
  collection,
  payload,
  settings,
  user,
}: {
  collection: string
  payload: Payload
  settings: XeroSettingsDoc
  user: Record<string, unknown>
}): Promise<void> => {
  const config = payload.collections[collection]?.config
  if (!config) {
    throw new XeroOAuthError('settings_not_found', 'These Xero settings no longer exist.')
  }

  const req = await createPayloadRequest({ payload, req: {}, user: user as never })
  const permissions = await docAccessOperation({ collection: { config } as never, id: settings.id, req })

  // False, or (through the tenancy layer) a `where` that this row does not satisfy.
  if (!permissions.update) {
    throw new XeroOAuthError('not_authorised', 'You cannot manage Xero settings for this tenant.')
  }
}

/** Encrypt and store a token set on the settings row. Returns the updated row. */
export const saveXeroTokens = async ({
  collection,
  data,
  encryptionKey,
  payload,
  settings,
  tokens,
}: SaveTokensArgs): Promise<XeroSettingsDoc> => {
  const key = requireKey(encryptionKey)

  return (await payload.update({
    collection,
    data: {
      ...data,
      tokens: await encryptedTokenColumns(tokens, key, tokenContext(settings.id)),
    },
    id: settings.id,
    overrideAccess: true,
  })) as unknown as XeroSettingsDoc
}

/** Decrypt one token value. A token that will not decrypt is treated as absent. */
const decryptOrNull = async (
  value: null | string | undefined,
  key: string,
  context: string,
): Promise<null | string> => {
  if (!value) return null

  try {
    return await decryptToken(value, key, context)
  } catch {
    return null
  }
}

/**
 * The settings row with `tokens` filled in. Every other read path (the REST API, the admin
 * panel) gets the row without tokens, so callers must come through here.
 */
export const findSettingsWithTokens = async ({
  collection,
  id,
  payload,
}: {
  collection: string
  id: number | string
  payload: Payload
}): Promise<null | XeroSettingsDoc> => {
  const doc = (await payload.findByID({
    collection,
    depth: 0,
    id,
    overrideAccess: true,
    showHiddenFields: true,
  })) as unknown as XeroSettingsDoc | undefined

  return doc ?? null
}

export type XeroAccessToken = {
  accessToken: string
  /** ISO timestamp of the access token's expiry. */
  expiresAt: string
  /** True when the token was refreshed on this call. */
  refreshed: boolean
  settings: XeroSettingsDoc
}

export type AccessTokenArgs = {
  /** Settings collection slug. */
  collection: string
  /** Current time, for tests. Defaults to `Date.now()`. */
  now?: number
  /** OAuth options: credentials, `fetch`, encryption key. */
  oauth: XeroOAuthOptions
  payload: Payload
  settings: XeroSettingsDoc
}

/** A decrypted view of the row's token columns. */
type StoredTokens = {
  accessToken: null | string
  expiresAt: null | string
  refreshToken: null | string
  /** The encrypted refresh token, which is what the compare-and-swap matches on. */
  refreshTokenCipher: null | string
}

const readStoredTokens = async (
  stored: null | XeroStoredTokens | undefined,
  key: string,
  context: string,
): Promise<StoredTokens> => ({
  accessToken: await decryptOrNull(stored?.accessToken, key, context),
  expiresAt: stored?.expiresAt ?? null,
  refreshToken: await decryptOrNull(stored?.refreshToken, key, context),
  refreshTokenCipher: stored?.refreshToken ?? null,
})

/** True when the stored access token lives past the refresh margin. */
const isLive = (tokens: StoredTokens, now: number): boolean =>
  Boolean(
    tokens.accessToken &&
      tokens.expiresAt &&
      Date.parse(tokens.expiresAt) - XERO_REFRESH_MARGIN_MS > now,
  )

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Take the row's refresh lease, but only while the refresh token is still the one this request
 * read and nobody else holds an unexpired lease. One conditional `UPDATE` decides all of that,
 * so of any number of concurrent requests exactly one wins. Returns the lease token on success.
 *
 * The lease runs on the wall clock rather than the caller's `now`: it is about real requests
 * racing, not about the access token's lifetime.
 */
const claimRefreshLease = async ({
  collection,
  payload,
  refreshTokenCipher,
  settingsID,
}: {
  collection: string
  payload: Payload
  refreshTokenCipher: null | string
  settingsID: number | string
}): Promise<null | string> => {
  const leaseToken = crypto.randomUUID()

  const claimed = await payload.db.updateOne({
    collection,
    data: {
      tokens: {
        refreshLockToken: leaseToken,
        refreshLockedUntil: Date.now() + XERO_REFRESH_LEASE_MS,
      },
    },
    where: {
      and: [
        { id: { equals: settingsID } },
        { 'tokens.refreshToken': { equals: refreshTokenCipher } },
        {
          or: [
            { 'tokens.refreshLockedUntil': { exists: false } },
            { 'tokens.refreshLockedUntil': { less_than: Date.now() } },
          ],
        },
      ],
    },
  })

  return claimed ? leaseToken : null
}

/** Give the lease back after a failed refresh, so a retry need not wait it out. */
const releaseRefreshLease = async ({
  collection,
  leaseToken,
  payload,
  settingsID,
}: {
  collection: string
  leaseToken: string
  payload: Payload
  settingsID: number | string
}): Promise<void> => {
  try {
    await payload.db.updateOne({
      collection,
      data: { tokens: { refreshLockToken: null, refreshLockedUntil: null } },
      where: {
        and: [
          { id: { equals: settingsID } },
          { 'tokens.refreshLockToken': { equals: leaseToken } },
        ],
      },
    })
  } catch {
    // The lease expires by itself; failing to hand it back only delays the next refresh.
  }
}

/** The row as it is in the database now, tokens included. */
const reloadSettings = ({
  collection,
  id,
  payload,
}: {
  collection: string
  id: number | string
  payload: Payload
}): Promise<null | XeroSettingsDoc> => findSettingsWithTokens({ collection, id, payload })

/**
 * Wait for whoever holds the lease to save its tokens, then return the reloaded row. The wait
 * is bounded by the caller's deadline, so a holder that dies never hangs this request.
 */
const waitForLease = async ({
  collection,
  deadline,
  payload,
  settings,
}: {
  collection: string
  deadline: number
  payload: Payload
  settings: XeroSettingsDoc
}): Promise<null | XeroSettingsDoc> => {
  while (Date.now() < deadline) {
    await sleep(REFRESH_POLL_MS)

    const reloaded = await reloadSettings({ collection, id: settings.id, payload })
    if (!reloaded) return null

    const heldUntil = reloaded.tokens?.refreshLockedUntil ?? 0
    // The holder either saved (tokens changed, lease cleared) or gave up (lease cleared).
    if (!heldUntil || heldUntil <= Date.now()) return reloaded
  }

  return reloadSettings({ collection, id: settings.id, payload })
}

/**
 * A currently valid access token for this tenant, refreshing it when it is missing, expired
 * or about to expire. Throws `not_connected` when the tenant has never connected.
 *
 * Only one request per settings row refreshes at a time. A request that loses the race waits
 * for the winner's tokens instead of spending a refresh token Xero has already retired.
 */
export const getXeroAccessToken = async ({
  collection,
  now = Date.now(),
  oauth,
  payload,
  settings,
}: AccessTokenArgs): Promise<XeroAccessToken> => {
  const key = requireKey(oauth.encryptionKey)
  // One deadline for the whole call, so a row that stays busy cannot hold the request open
  // for several leases in a row.
  const deadline = Date.now() + XERO_REFRESH_LEASE_MS + REFRESH_WAIT_SLACK_MS
  let current = settings

  for (;;) {
    const tokens = await readStoredTokens(current.tokens, key, tokenContext(current.id))

    if (isLive(tokens, now)) {
      return {
        accessToken: tokens.accessToken as string,
        expiresAt: tokens.expiresAt as string,
        refreshed: false,
        settings: current,
      }
    }

    if (!tokens.refreshToken) {
      throw new XeroOAuthError(
        'not_connected',
        'Xero is not connected for this tenant. Connect it from the Xero settings.',
      )
    }

    if (Date.now() >= deadline) {
      // Out of time with a peer still refreshing. Report that rather than spend a refresh
      // token that may already be retired.
      throw new XeroOAuthError(
        'refresh_failed',
        'The Xero connection is being refreshed by another request. Try again.',
      )
    }

    const leaseToken = await claimRefreshLease({
      collection,
      payload,
      refreshTokenCipher: tokens.refreshTokenCipher,
      settingsID: current.id,
    })

    if (!leaseToken) {
      // Another request holds the lease, or has just finished with it. Take its result.
      const reloaded = await waitForLease({ collection, deadline, payload, settings: current })
      if (!reloaded) {
        throw new XeroOAuthError('settings_not_found', 'These Xero settings no longer exist.')
      }

      current = reloaded
      continue
    }

    try {
      const refreshedTokens = await refreshAccessToken(oauth, {
        now,
        refreshToken: tokens.refreshToken,
      })
      // Xero may not repeat the refresh token; the old one stays valid only until it does, so
      // keep the current one when the response has none.
      const updated = await saveXeroTokens({
        collection,
        encryptionKey: oauth.encryptionKey,
        payload,
        settings: current,
        tokens: {
          ...refreshedTokens,
          refreshToken: refreshedTokens.refreshToken ?? tokens.refreshToken,
        },
      })

      return {
        accessToken: refreshedTokens.accessToken,
        expiresAt: refreshedTokens.expiresAt,
        refreshed: true,
        settings: updated,
      }
    } catch (error) {
      await releaseRefreshLease({ collection, leaseToken, payload, settingsID: current.id })
      throw error
    }
  }
}
