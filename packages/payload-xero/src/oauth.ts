/**
 * Xero OAuth2 (authorization code flow) on `fetch` and Web Crypto only, so it runs on
 * Cloudflare Workers. No Node SDK, no Node-only APIs.
 *
 * Two halves:
 *
 * - the token client (`buildAuthorizeUrl`, `exchangeCodeForTokens`, `refreshAccessToken`,
 *   `fetchXeroConnections`), which only talks HTTP;
 * - the signed `state`, which carries the tenant and the user through the redirect to Xero and
 *   back. The callback is a cross-site top-level navigation, so the admin's cookie is not a
 *   reliable identity there; the signature is.
 *
 * The client is a confidential client (ID and secret from env), so PKCE is not used.
 */

/**
 * The scopes the plugin requests, always. They are not configurable: the set is what the
 * package's connection needs, and letting a caller widen it would make tenants consent to
 * permissions the documented connection never asks for.
 */
export const XERO_OAUTH_SCOPES = [
  'offline_access',
  'accounting.transactions',
  'accounting.settings',
  'accounting.contacts',
] as const

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize'
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections'

export const XERO_CLIENT_ID_ENV = 'XERO_CLIENT_ID'
export const XERO_CLIENT_SECRET_ENV = 'XERO_CLIENT_SECRET'
export const XERO_REDIRECT_URI_ENV = 'XERO_REDIRECT_URI'
export const XERO_STATE_SECRET_ENV = 'XERO_STATE_SECRET'

/** Refresh this long before expiry, so a request never races the access token's lifetime. */
export const XERO_REFRESH_MARGIN_MS = 60_000
/**
 * Give up on a token request after this long. Kept below `XERO_REFRESH_LEASE_MS`, so a hung
 * Xero cannot leave a request refreshing past the point where a peer may take the lease over.
 */
export const XERO_TOKEN_REQUEST_TIMEOUT_MS = 10_000
/** How long the connect link (the signed state) stays valid. */
export const XERO_STATE_TTL_SECONDS = 600
/** Cookie that binds a connect attempt to the browser that started it. */
export const XERO_OAUTH_COOKIE = 'xero_oauth'

const STATE_VERSION = 'v1'

export type XeroOAuthErrorCode =
  | 'access_denied'
  | 'invalid_request'
  | 'invalid_response'
  | 'invalid_state'
  | 'no_organisation'
  | 'not_authorised'
  | 'not_authenticated'
  | 'not_configured'
  | 'not_connected'
  | 'refresh_failed'
  | 'settings_not_found'
  | 'token_request_failed'

const STATUS: Record<XeroOAuthErrorCode, number> = {
  access_denied: 400,
  invalid_request: 400,
  invalid_response: 502,
  invalid_state: 400,
  no_organisation: 502,
  not_authorised: 403,
  not_authenticated: 401,
  not_configured: 500,
  not_connected: 409,
  refresh_failed: 502,
  settings_not_found: 404,
  token_request_failed: 502,
}

/**
 * An OAuth failure with a stable `code` for the HTTP layer. Messages never contain tokens:
 * `details` carries only Xero's own error code (and a short description).
 */
export class XeroOAuthError extends Error {
  readonly code: XeroOAuthErrorCode
  readonly details?: Record<string, unknown>
  readonly status: number

  constructor(code: XeroOAuthErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'XeroOAuthError'
    this.code = code
    this.details = details
    this.status = STATUS[code]
  }
}

export type Resolvable<T> = T | (() => T | undefined)

const readValue = <T>(value: Resolvable<T> | undefined): T | undefined =>
  typeof value === 'function' ? (value as () => T | undefined)() : value

const readEnv = (name: string): string | undefined => {
  const scope = globalThis as { process?: { env?: Record<string, string | undefined> } }

  return scope.process?.env?.[name]
}

export type XeroOAuthOptions = {
  /** Authorize endpoint. Defaults to Xero's login host; tests point it elsewhere. */
  authorizeUrl?: string
  /**
   * Xero app client ID, or a function returning it. Defaults to the `XERO_CLIENT_ID` env var.
   * Reading it lazily matters on Workers, where env is only available per request.
   */
  clientId?: Resolvable<string>
  /** Xero app client secret. Defaults to `XERO_CLIENT_SECRET`. Never commit it. */
  clientSecret?: Resolvable<string>
  /** Connections endpoint. Defaults to `https://api.xero.com/connections`. */
  connectionsUrl?: string
  /**
   * AES-256-GCM key (base64, 32 bytes) for tokens at rest. Defaults to
   * `XERO_TOKEN_ENCRYPTION_KEY`. Only needed by the code that stores or reads tokens.
   */
  encryptionKey?: Resolvable<string>
  /** `fetch` implementation, for tests. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Must match the redirect URI registered on the Xero app. Defaults to `XERO_REDIRECT_URI`. */
  redirectUri?: Resolvable<string>
  /** HMAC key for the signed `state`. Defaults to `XERO_STATE_SECRET`, then the Payload secret. */
  stateSecret?: Resolvable<string>
  /** Lifetime of the signed state, in seconds. Defaults to 600. */
  stateTtlSeconds?: number
  /** How long to wait for Xero's token endpoint. Defaults to 10s; keep it under the refresh lease. */
  tokenRequestTimeoutMs?: number
  /** Token endpoint. Defaults to Xero's identity host; tests point it elsewhere. */
  tokenUrl?: string
}

export type ResolvedXeroOAuth = {
  authorizeUrl: string
  clientId: string
  clientSecret: string
  connectionsUrl: string
  encryptionKey: string | undefined
  fetch: typeof globalThis.fetch
  /** Absent when only refreshing: a refresh needs no redirect URI. */
  redirectUri: string | undefined
  /** Deadline for a token request, in milliseconds. */
  tokenRequestTimeoutMs: number
  scopes: readonly string[]
  stateSecret: string | undefined
  stateTtlSeconds: number
  tokenUrl: string
}

/** Resolve options and env, and fail early with a clear error rather than at the first request. */
export const resolveXeroOAuth = (options: XeroOAuthOptions = {}): ResolvedXeroOAuth => {
  const clientId = readValue(options.clientId) ?? readEnv(XERO_CLIENT_ID_ENV)
  const clientSecret = readValue(options.clientSecret) ?? readEnv(XERO_CLIENT_SECRET_ENV)

  if (!clientId || !clientSecret) {
    throw new XeroOAuthError(
      'not_configured',
      `Xero OAuth needs a client ID and a client secret (${XERO_CLIENT_ID_ENV}, ${XERO_CLIENT_SECRET_ENV}).`,
    )
  }

  const fetchFn = options.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new XeroOAuthError('not_configured', 'Xero OAuth needs a fetch implementation.')
  }

  return {
    authorizeUrl: options.authorizeUrl ?? XERO_AUTHORIZE_URL,
    clientId,
    clientSecret,
    connectionsUrl: options.connectionsUrl ?? XERO_CONNECTIONS_URL,
    encryptionKey: readValue(options.encryptionKey),
    fetch: fetchFn,
    redirectUri: readValue(options.redirectUri) ?? readEnv(XERO_REDIRECT_URI_ENV),
    scopes: XERO_OAUTH_SCOPES,
    stateSecret: readValue(options.stateSecret) ?? readEnv(XERO_STATE_SECRET_ENV),
    stateTtlSeconds: options.stateTtlSeconds ?? XERO_STATE_TTL_SECONDS,
    tokenRequestTimeoutMs: options.tokenRequestTimeoutMs ?? XERO_TOKEN_REQUEST_TIMEOUT_MS,
    tokenUrl: options.tokenUrl ?? XERO_TOKEN_URL,
  }
}

/* -------------------------------------------------------------------------- */
/* Signed state                                                               */
/* -------------------------------------------------------------------------- */

export type XeroOAuthState = {
  /** Auth collection of the user who started the flow. */
  collection: string
  /** Epoch milliseconds after which the state is refused. */
  expiresAt: number
  /**
   * Random value also set as a cookie on the browser that started the flow. The callback must
   * present the same value, which is what stops an attacker handing a victim a connect link and
   * having the victim's Xero account linked to the attacker's settings row.
   */
  nonce: string
  /** The settings row this connection writes to, so the callback cannot stray to another. */
  settings: number | string
  /** Tenant the connection belongs to; null in global scope. */
  tenant: null | number | string
  user: number | string
}

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new XeroOAuthError('invalid_state', 'Invalid state')

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)

  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const hmacKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
  ])

const signatureOf = async (secret: string, body: string): Promise<string> =>
  toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body))))

const isID = (value: unknown): value is number | string =>
  typeof value === 'number' || (typeof value === 'string' && value.length > 0)

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false

  let mismatch = 0
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)

  return mismatch === 0
}

const invalidState = (): XeroOAuthError =>
  new XeroOAuthError('invalid_state', 'This connect link is invalid or has expired.')

/** A fresh state for one connect attempt: settings row, tenant and user, signed, with a short expiry. */
export const signOAuthState = async ({
  now = Date.now(),
  secret,
  state,
}: {
  now?: number
  secret: string
  state: Omit<XeroOAuthState, 'expiresAt'> & { expiresAt?: number }
}): Promise<string> => {
  if (!secret) throw new XeroOAuthError('not_configured', 'Xero OAuth needs a state secret.')

  const body = toBase64Url(
    encoder.encode(
      JSON.stringify({
        collection: state.collection,
        expiresAt: state.expiresAt ?? now + XERO_STATE_TTL_SECONDS * 1000,
        nonce: state.nonce,
        settings: state.settings,
        tenant: state.tenant,
        user: state.user,
      }),
    ),
  )

  return `${STATE_VERSION}.${body}.${await signatureOf(secret, `${STATE_VERSION}.${body}`)}`
}

/** Verify a state's signature and expiry. Any problem is the same error, so nothing leaks. */
export const verifyOAuthState = async ({
  now = Date.now(),
  secret,
  token,
}: {
  now?: number
  secret: string
  token: null | string | undefined
}): Promise<XeroOAuthState> => {
  if (!secret || !token) throw invalidState()

  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== STATE_VERSION) throw invalidState()

  const expected = await signatureOf(secret, `${parts[0]}.${parts[1]}`)
  if (!timingSafeEqual(expected, parts[2])) throw invalidState()

  let state: XeroOAuthState
  try {
    state = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as XeroOAuthState
  } catch {
    throw invalidState()
  }

  if (
    !state ||
    typeof state !== 'object' ||
    typeof state.collection !== 'string' ||
    typeof state.expiresAt !== 'number' ||
    typeof state.nonce !== 'string' ||
    state.nonce.length === 0 ||
    !isID(state.settings) ||
    !isID(state.user)
  ) {
    throw invalidState()
  }

  if (state.expiresAt <= now) throw invalidState()

  return state
}

/* -------------------------------------------------------------------------- */
/* Token client                                                               */
/* -------------------------------------------------------------------------- */

export type XeroTokenSet = {
  accessToken: string
  /** ISO timestamp, computed from Xero's `expires_in`. */
  expiresAt: string
  refreshToken: null | string
  scope: null | string
}

/** The redirect URI registered on the Xero app. Needed to authorize and to exchange a code. */
const requireRedirectUri = (resolved: ResolvedXeroOAuth): string => {
  if (!resolved.redirectUri) {
    throw new XeroOAuthError(
      'not_configured',
      `Xero OAuth needs the registered redirect URI (${XERO_REDIRECT_URI_ENV}).`,
    )
  }

  return resolved.redirectUri
}

/** The URL an admin is sent to. `state` must come from `signOAuthState`. */
export const buildAuthorizeUrl = (
  options: XeroOAuthOptions,
  { state }: { state: string },
): string => {
  const resolved = resolveXeroOAuth(options)
  const url = new URL(resolved.authorizeUrl)

  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', resolved.clientId)
  url.searchParams.set('redirect_uri', requireRedirectUri(resolved))
  url.searchParams.set('scope', resolved.scopes.join(' '))
  url.searchParams.set('state', state)

  return url.toString()
}

const authorizationHeader = (resolved: ResolvedXeroOAuth): string =>
  `Basic ${btoa(`${resolved.clientId}:${resolved.clientSecret}`)}`

type TokenResponse = {
  access_token?: unknown
  error?: unknown
  error_description?: unknown
  expires_in?: unknown
  refresh_token?: unknown
  scope?: unknown
}

const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await response.json()

    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const toTokenSet = (body: TokenResponse, now: number): XeroTokenSet => {
  const { access_token: accessToken, expires_in: expiresIn } = body

  if (typeof accessToken !== 'string' || !accessToken || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
    throw new XeroOAuthError('invalid_response', 'Xero did not return a usable access token.')
  }

  return {
    accessToken,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
  }
}

const requestTokens = async ({
  body,
  code,
  now = Date.now(),
  options,
}: {
  body: Record<string, string>
  code: 'exchange' | 'refresh'
  now?: number
  options: XeroOAuthOptions
}): Promise<XeroTokenSet> => {
  const resolved = resolveXeroOAuth(options)

  let response: Response
  try {
    response = await resolved.fetch(resolved.tokenUrl, {
      body: new URLSearchParams(body).toString(),
      headers: {
        accept: 'application/json',
        authorization: authorizationHeader(resolved),
        'content-type': 'application/x-www-form-urlencoded',
      },
      method: 'POST',
      signal: AbortSignal.timeout(resolved.tokenRequestTimeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'

    throw new XeroOAuthError(
      code === 'refresh' ? 'refresh_failed' : 'token_request_failed',
      timedOut
        ? 'Xero did not answer in time. Try again shortly.'
        : 'Could not reach Xero. Try again shortly.',
      { cause: error instanceof Error ? error.name : 'network_error' },
    )
  }

  const payload = (await readJson(response)) as TokenResponse

  if (!response.ok) {
    const errorCode = typeof payload.error === 'string' ? payload.error : 'unknown_error'
    const description = typeof payload.error_description === 'string' ? payload.error_description : undefined

    throw new XeroOAuthError(
      code === 'refresh' ? 'refresh_failed' : 'token_request_failed',
      `Xero refused the ${code === 'refresh' ? 'token refresh' : 'authorization code'} (${errorCode}).`,
      description ? { description: description.slice(0, 200), error: errorCode, status: response.status } : { error: errorCode, status: response.status },
    )
  }

  return toTokenSet(payload, now)
}

/** Trade the authorization code from the callback for tokens. */
export const exchangeCodeForTokens = async (
  options: XeroOAuthOptions,
  { code, now }: { code: string; now?: number },
): Promise<XeroTokenSet> =>
  requestTokens({
    body: {
      code,
      grant_type: 'authorization_code',
      redirect_uri: requireRedirectUri(resolveXeroOAuth(options)),
    },
    code: 'exchange',
    now,
    options,
  })

/**
 * Refresh an access token. Xero rotates the refresh token: the returned set can carry a new
 * one, and callers must persist it. The old refresh token is dead once Xero has answered.
 */
export const refreshAccessToken = async (
  options: XeroOAuthOptions,
  { now, refreshToken }: { now?: number; refreshToken: string },
): Promise<XeroTokenSet> =>
  requestTokens({
    body: { grant_type: 'refresh_token', refresh_token: refreshToken },
    code: 'refresh',
    now,
    options,
  })

export type XeroConnection = {
  id?: string
  tenantId?: string
  tenantName?: string
  tenantType?: string
}

/** The organisations this access token can reach. */
export const fetchXeroConnections = async (
  options: XeroOAuthOptions,
  { accessToken }: { accessToken: string },
): Promise<XeroConnection[]> => {
  const resolved = resolveXeroOAuth(options)

  let response: Response
  try {
    response = await resolved.fetch(resolved.connectionsUrl, {
      headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
      method: 'GET',
    })
  } catch (error) {
    throw new XeroOAuthError('invalid_response', 'Could not reach Xero to list connections.', {
      cause: error instanceof Error ? error.name : 'network_error',
    })
  }

  if (!response.ok) {
    throw new XeroOAuthError('invalid_response', `Xero refused the connections request (HTTP ${response.status}).`, {
      status: response.status,
    })
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new XeroOAuthError('invalid_response', 'Xero returned an unreadable connections response.')
  }

  if (!Array.isArray(body)) {
    throw new XeroOAuthError('invalid_response', 'Xero returned an unreadable connections response.')
  }

  return body.filter(
    (connection): connection is XeroConnection => Boolean(connection) && typeof connection === 'object',
  )
}

/**
 * The organisation ID to store on the settings. Xero's `/connections` also lists practice
 * tenants; invoices belong to an organisation.
 */
export const xeroOrganisationId = (connections: XeroConnection[]): string => {
  const organisation = connections.find(
    (connection) => connection.tenantType === 'ORGANISATION' && typeof connection.tenantId === 'string' && connection.tenantId,
  )

  if (!organisation?.tenantId) {
    throw new XeroOAuthError(
      'no_organisation',
      'This Xero login has no organisation connected. Ask a Xero admin to grant access to the organisation.',
    )
  }

  return organisation.tenantId
}
