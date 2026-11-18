import { describe, expect, it, vi } from 'vitest'

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchXeroConnections,
  refreshAccessToken,
  resolveXeroOAuth,
  signOAuthState,
  verifyOAuthState,
  XERO_OAUTH_SCOPES,
  XeroOAuthError,
  xeroOrganisationId,
} from './oauth'

const SECRET = 'state-secret-for-tests'
const NOW = Date.parse('2026-11-18T10:00:00Z')

const baseOptions = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.invalid/api/xero/callback',
  stateSecret: SECRET,
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const tokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'access-token-1',
  expires_in: 1800,
  refresh_token: 'refresh-token-1',
  scope: XERO_OAUTH_SCOPES.join(' '),
  token_type: 'Bearer',
  ...overrides,
})

describe('resolveXeroOAuth', () => {
  it('needs a client ID and a secret, and names the env vars', () => {
    expect(() => resolveXeroOAuth({})).toThrow(XeroOAuthError)
    expect(() => resolveXeroOAuth({})).toThrow('XERO_CLIENT_ID')
    expect(() => resolveXeroOAuth({ clientId: 'a' })).toThrow('XERO_CLIENT_SECRET')
    // Refreshing needs no redirect URI; authorizing does (checked below).
    expect(resolveXeroOAuth({ clientId: 'a', clientSecret: 'b' }).redirectUri).toBeUndefined()
    expect(() => buildAuthorizeUrl({ clientId: 'a', clientSecret: 'b' }, { state: 's' })).toThrow(
      'XERO_REDIRECT_URI',
    )
  })

  it('takes the state secret from XERO_STATE_SECRET when the option is unset', () => {
    vi.stubEnv('XERO_STATE_SECRET', 'env-state-secret')

    try {
      expect(resolveXeroOAuth(baseOptions).stateSecret).toBe(SECRET)
      expect(
        resolveXeroOAuth({ clientId: 'a', clientSecret: 'b' }).stateSecret,
      ).toBe('env-state-secret')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('defaults the scopes, endpoints and state lifetime', () => {
    const resolved = resolveXeroOAuth(baseOptions)

    expect(resolved.scopes).toEqual([...XERO_OAUTH_SCOPES])
    expect(resolved.authorizeUrl).toBe('https://login.xero.com/identity/connect/authorize')
    expect(resolved.tokenUrl).toBe('https://identity.xero.com/connect/token')
    expect(resolved.connectionsUrl).toBe('https://api.xero.com/connections')
    expect(resolved.stateTtlSeconds).toBe(600)
  })

  it('reads the credentials from the environment and latest function values', () => {
    vi.stubEnv('XERO_CLIENT_ID', 'env-id')
    vi.stubEnv('XERO_CLIENT_SECRET', 'env-secret')
    vi.stubEnv('XERO_REDIRECT_URI', 'https://env.invalid/callback')

    try {
      expect(resolveXeroOAuth()).toMatchObject({
        clientId: 'env-id',
        clientSecret: 'env-secret',
        redirectUri: 'https://env.invalid/callback',
      })

      // Workers env is per request, so callers pass getters rather than values.
      let secret = 'first'
      const resolved = resolveXeroOAuth({
        ...baseOptions,
        clientSecret: () => secret,
        encryptionKey: () => 'key-from-env',
      })
      expect(resolved.clientSecret).toBe('first')
      secret = 'second'
      expect(resolveXeroOAuth({ ...baseOptions, clientSecret: () => secret }).clientSecret).toBe('second')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('authorize URL', () => {
  it('requests the offline scopes and the callback', () => {
    const url = new URL(buildAuthorizeUrl(baseOptions, { state: 'signed-state' }))

    expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('client_id')).toBe('client-id')
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.invalid/api/xero/callback')
    expect(url.searchParams.get('state')).toBe('signed-state')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual([
      'offline_access',
      'accounting.transactions',
      'accounting.settings',
      'accounting.contacts',
    ])
  })
})

describe('signed state', () => {
  const state = { collection: 'users', nonce: 'nonce-1', settings: 3, tenant: 7, user: 42 }

  it('round-trips the tenant and user', async () => {
    const token = await signOAuthState({ now: NOW, secret: SECRET, state })
    const verified = await verifyOAuthState({ now: NOW + 1000, secret: SECRET, token })

    expect(verified).toMatchObject({
      collection: 'users',
      nonce: 'nonce-1',
      settings: 3,
      tenant: 7,
      user: 42,
    })
    expect(verified.expiresAt).toBe(NOW + 600_000)
  })

  it('refuses a state signed with another secret, so a tenant cannot forge one', async () => {
    const token = await signOAuthState({ now: NOW, secret: SECRET, state })

    await expect(
      verifyOAuthState({ now: NOW, secret: 'another-secret', token }),
    ).rejects.toThrow('invalid or has expired')
  })

  it('refuses a state whose payload was edited', async () => {
    const token = await signOAuthState({ now: NOW, secret: SECRET, state })
    const [version, , signature] = token.split('.')
    const forged = btoa(JSON.stringify({ ...state, tenant: 8 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    await expect(
      verifyOAuthState({ now: NOW, secret: SECRET, token: `${version}.${forged}.${signature}` }),
    ).rejects.toThrow(XeroOAuthError)
  })

  it('refuses an expired state', async () => {
    const token = await signOAuthState({ now: NOW, secret: SECRET, state })

    await expect(
      verifyOAuthState({ now: NOW + 600_001, secret: SECRET, token }),
    ).rejects.toThrow('invalid or has expired')
  })

  it('refuses a state that carries no browser nonce', async () => {
    const token = await signOAuthState({
      now: NOW,
      secret: SECRET,
      state: { ...state, nonce: '' },
    })

    await expect(verifyOAuthState({ now: NOW, secret: SECRET, token })).rejects.toThrow(
      'invalid or has expired',
    )
  })

  it('refuses missing and malformed states', async () => {
    for (const token of [null, undefined, '', 'garbage', 'v2.a.b', 'v1.only-two']) {
      await expect(verifyOAuthState({ now: NOW, secret: SECRET, token })).rejects.toThrow(XeroOAuthError)
    }
  })

  it('refuses to sign without a secret', async () => {
    await expect(signOAuthState({ now: NOW, secret: '', state })).rejects.toThrow('state secret')
  })
})

describe('token exchange', () => {
  it('sends the code with a Basic auth header and returns the token set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(tokenBody()))
    const tokens = await exchangeCodeForTokens(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { code: 'the-code', now: NOW },
    )

    expect(tokens).toEqual({
      accessToken: 'access-token-1',
      expiresAt: new Date(NOW + 1_800_000).toISOString(),
      refreshToken: 'refresh-token-1',
      scope: XERO_OAUTH_SCOPES.join(' '),
    })

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://identity.xero.com/connect/token')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa('client-id:client-secret')}`,
    )
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    )

    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('redirect_uri')).toBe(baseOptions.redirectUri)
  })

  it('reports Xero’s refusal without echoing the code or the secret', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'invalid_grant', error_description: 'code has expired' }, 400),
    )

    const error = (await exchangeCodeForTokens(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { code: 'secret-code', now: NOW },
    ).catch((caught: unknown) => caught)) as XeroOAuthError

    expect(error).toBeInstanceOf(XeroOAuthError)
    expect(error.code).toBe('token_request_failed')
    expect(error.status).toBe(502)
    expect(error.details).toMatchObject({ error: 'invalid_grant' })
    expect(error.message).not.toContain('secret-code')
    expect(error.message).not.toContain('client-secret')
  })

  it('rejects a response with no usable access token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: '', expires_in: 1800 }))

    await expect(
      exchangeCodeForTokens({ ...baseOptions, fetch: fetchMock as unknown as typeof fetch }, { code: 'c' }),
    ).rejects.toThrow('usable access token')
  })

  it('turns a network failure into a clear error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('network down')
    })

    const error = (await exchangeCodeForTokens(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { code: 'c' },
    ).catch((caught: unknown) => caught)) as XeroOAuthError

    expect(error.code).toBe('token_request_failed')
    expect(error.message).toContain('reach Xero')
  })
})

describe('token refresh', () => {
  it('sends the refresh token and returns the rotated set', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(tokenBody({ access_token: 'access-token-2', refresh_token: 'refresh-token-2' })),
    )

    const tokens = await refreshAccessToken(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { now: NOW, refreshToken: 'refresh-token-1' },
    )

    expect(tokens.accessToken).toBe('access-token-2')
    expect(tokens.refreshToken).toBe('refresh-token-2')

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-token-1')
  })

  it('reports a rejected refresh as refresh_failed', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400))

    const error = (await refreshAccessToken(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { refreshToken: 'dead-token' },
    ).catch((caught: unknown) => caught)) as XeroOAuthError

    expect(error.code).toBe('refresh_failed')
    expect(error.message).not.toContain('dead-token')
  })
})

describe('connections', () => {
  it('lists them with the bearer token', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse([
        { tenantId: 'practice-1', tenantName: 'Practice', tenantType: 'PRACTICEMANAGER' },
        { tenantId: 'org-1', tenantName: 'Vanuatu Wok', tenantType: 'ORGANISATION' },
      ]),
    )

    const connections = await fetchXeroConnections(
      { ...baseOptions, fetch: fetchMock as unknown as typeof fetch },
      { accessToken: 'access-token-1' },
    )

    expect(connections).toHaveLength(2)
    expect(xeroOrganisationId(connections)).toBe('org-1')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.xero.com/connections')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-token-1')
  })

  it('picks the organisation, never a practice tenant', () => {
    expect(() =>
      xeroOrganisationId([{ tenantId: 'practice', tenantType: 'PRACTICEMANAGER' }]),
    ).toThrow('no organisation connected')
    expect(() => xeroOrganisationId([])).toThrow(XeroOAuthError)
  })

  it('rejects a non-array or failed response', async () => {
    for (const response of [jsonResponse({ message: 'nope' }), jsonResponse([], 401)]) {
      await expect(
        fetchXeroConnections(
          { ...baseOptions, fetch: (async () => response) as unknown as typeof fetch },
          { accessToken: 'token' },
        ),
      ).rejects.toThrow(XeroOAuthError)
    }
  })
})
