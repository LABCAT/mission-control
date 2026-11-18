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
 */

import type { Payload } from 'payload'

import { decryptToken, encryptToken, XERO_TOKEN_KEY_ENV } from './crypto'
import {
  refreshAccessToken,
  type XeroOAuthOptions,
  XeroOAuthError,
  type XeroTokenSet,
  XERO_REFRESH_MARGIN_MS,
} from './oauth'

export type XeroStoredTokens = {
  /** Encrypted access token. */
  accessToken?: null | string
  /** ISO timestamp of the access token's expiry. */
  expiresAt?: null | string
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
  const context = tokenContext(settings.id)

  return (await payload.update({
    collection,
    data: {
      ...data,
      tokens: {
        accessToken: await encryptToken(tokens.accessToken, key, context),
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken
          ? await encryptToken(tokens.refreshToken, key, context)
          : null,
        scope: tokens.scope,
      },
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

/**
 * A currently valid access token for this tenant, refreshing it when it is missing, expired
 * or about to expire. Throws `not_connected` when the tenant has never connected.
 */
export const getXeroAccessToken = async ({
  collection,
  now = Date.now(),
  oauth,
  payload,
  settings,
}: AccessTokenArgs): Promise<XeroAccessToken> => {
  const key = requireKey(oauth.encryptionKey)
  const context = tokenContext(settings.id)
  const stored = settings.tokens

  const accessToken = await decryptOrNull(stored?.accessToken, key, context)
  const storedExpiry = stored?.expiresAt ?? null
  const expiry = storedExpiry ? Date.parse(storedExpiry) : Number.NaN

  if (accessToken && storedExpiry && expiry - XERO_REFRESH_MARGIN_MS > now) {
    return { accessToken, expiresAt: storedExpiry, refreshed: false, settings }
  }

  const refreshToken = await decryptOrNull(stored?.refreshToken, key, context)

  if (!refreshToken) {
    throw new XeroOAuthError(
      'not_connected',
      'Xero is not connected for this tenant. Connect it from the Xero settings.',
    )
  }

  const tokens = await refreshAccessToken(oauth, { now, refreshToken })
  // Xero may not repeat the refresh token; the old one stays valid only until it does, so keep
  // the current one when the response has none.
  const updated = await saveXeroTokens({
    collection,
    encryptionKey: oauth.encryptionKey,
    payload,
    settings,
    tokens: { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken },
  })

  return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt, refreshed: true, settings: updated }
}
