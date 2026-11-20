import type { SmtpOauthConfig } from './types'

type CacheEntry = { accessToken: string; expiresAt: number }

/** Per-isolate cache. Tokens live in memory only, never in config, the DB or logs. */
const tokenCache = new Map<string, CacheEntry>()

const cacheKey = (config: SmtpOauthConfig, endpoint: string): string =>
  `${endpoint}\n${config.clientId}\n${config.refreshToken}`

const EXPIRY_MARGIN_MS = 60_000

/**
 * Exchange a refresh token for an access token, caching it until ~60 seconds before it expires.
 * Throws a plain `Error` whose message may contain the endpoint's response; `sendViaSmtp` redacts
 * every secret before wrapping it in `EmailSendError`.
 */
export const getAccessToken = async (config: SmtpOauthConfig): Promise<string> => {
  const endpoint = config.tokenEndpoint ?? 'https://oauth2.googleapis.com/token'
  const now = Date.now()
  const cached = tokenCache.get(cacheKey(config, endpoint))
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) return cached.accessToken

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  })

  let response: Response
  try {
    response = await (config.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'request failed'
    throw new Error(`token endpoint request failed (${reason})`, { cause: error })
  }

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 300)
    } catch {
      // A non-text body: the status alone is enough.
    }
    throw new Error(`token endpoint HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
  }

  let data: { access_token?: unknown; expires_in?: unknown }
  try {
    data = (await response.json()) as { access_token?: unknown; expires_in?: unknown }
  } catch {
    throw new Error('token endpoint returned invalid JSON')
  }
  if (typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('token endpoint returned no access_token')
  }

  const expiresIn =
    typeof data.expires_in === 'number' && Number.isFinite(data.expires_in) && data.expires_in > 0
      ? data.expires_in
      : 3600
  tokenCache.set(cacheKey(config, endpoint), {
    accessToken: data.access_token,
    expiresAt: now + expiresIn * 1000,
  })
  return data.access_token
}

/** Test helper: forget cached tokens between cases. */
export const clearAccessTokenCache = (): void => {
  tokenCache.clear()
}
