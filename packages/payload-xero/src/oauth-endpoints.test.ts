import { postgresAdapter, sql } from '@payloadcms/db-postgres'
import { multiTenantPlugin } from '@payloadcms/plugin-multi-tenant'
import {
  buildConfig,
  getPayload,
  handleEndpoints,
  type CollectionConfig,
  type Payload,
  type SanitizedConfig,
} from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateEncryptionKey } from './crypto'
import { payloadXero } from './index'
import { signOAuthState, XERO_OAUTH_SCOPES } from './oauth'
import { getXeroAccessToken, findSettingsWithTokens, saveXeroTokens } from './token-store'
import { tenantAdminAccess, tenantRoleOptions, isSuperAdmin, superAdminAccess } from './test/roles'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'xero_oauth_test'
const INSTANCE_KEY = 'xero-oauth-test'
const PASSWORD = 'correct horse battery'
const STATE_SECRET = 'xero-oauth-state-secret'
const ENCRYPTION_KEY = generateEncryptionKey()
const REDIRECT_URI = 'https://cms.example.invalid/api/xero/callback'

type Tenant = { id: number; slug: string }

const Users: CollectionConfig = {
  slug: 'users',
  admin: { useAsTitle: 'email' },
  access: { admin: () => true },
  auth: true,
  fields: [
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'user',
      options: [
        { label: 'Super admin', value: 'super-admin' },
        { label: 'User', value: 'user' },
      ],
      saveToJWT: true,
    },
  ],
  versions: false,
}

const Tenants: CollectionConfig = {
  slug: 'tenants',
  access: { create: superAdminAccess, read: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'slug', type: 'text', required: true, unique: true },
  ],
  versions: false,
}

/* -------------------------------------------------------------------------- */
/* A stand-in Xero, so no test touches the network                            */
/* -------------------------------------------------------------------------- */

type XeroCall = { body: null | Record<string, string>; method: string; url: string }

const xeroCalls: XeroCall[] = []
/** Refresh tokens Xero will still accept; it rotates them. */
let liveRefreshTokens = new Set<string>()
let accessTokenCounter = 0
let connections: { tenantId: string; tenantName: string; tenantType: string }[] = []

const issueTokens = (body: Record<string, string>) => {
  const refreshToken = `refresh-${++accessTokenCounter}`
  liveRefreshTokens.add(refreshToken)

  return {
    access_token: `access-${accessTokenCounter}`,
    expires_in: 1800,
    refresh_token: refreshToken,
    scope: body.grant_type === 'authorization_code' ? XERO_OAUTH_SCOPES.join(' ') : undefined,
    token_type: 'Bearer',
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, status })

const xeroFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  const method = init?.method ?? 'GET'
  const body =
    typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : null
  xeroCalls.push({ body, method, url })

  if (url.startsWith('https://identity.xero.com/connect/token')) {
    if (body?.grant_type === 'authorization_code') {
      return body.code === 'good-code'
        ? json(issueTokens(body))
        : json({ error: 'invalid_grant', error_description: 'code expired' }, 400)
    }

    if (body?.grant_type === 'refresh_token') {
      // Xero invalidates the old refresh token the moment it answers.
      if (!body.refresh_token || !liveRefreshTokens.has(body.refresh_token)) {
        return json({ error: 'invalid_grant' }, 400)
      }
      liveRefreshTokens.delete(body.refresh_token)

      return json(issueTokens(body))
    }

    return json({ error: 'unsupported_grant_type' }, 400)
  }

  if (url.startsWith('https://api.xero.com/connections')) {
    return json(connections)
  }

  return json({ error: 'not_found' }, 404)
}

const oauth = {
  clientId: 'xero-client-id',
  clientSecret: 'xero-client-secret',
  encryptionKey: ENCRYPTION_KEY,
  fetch: xeroFetch as unknown as typeof fetch,
  redirectUri: REDIRECT_URI,
  stateSecret: STATE_SECRET,
}

let payload: Payload
let config: SanitizedConfig
const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
let tenantA: Tenant
let tenantB: Tenant
let adminA: { token: string; user: { id: number } }
let adminB: { token: string; user: { id: number } }
let editorA: { token: string; user: { id: number } }
let superAdmin: { token: string; user: { id: number } }

const createTenant = async (name: string): Promise<Tenant> => {
  const doc = (await payload.create({
    collection: 'tenants',
    data: { name, slug: `${name}-${runId}` },
    overrideAccess: true,
  })) as unknown as { id: number; slug: string }

  return { id: doc.id, slug: doc.slug }
}

const createUser = async (email: string, tenants: { role: string; tenant: number }[], role = 'user') => {
  await payload.create({
    collection: 'users',
    data: { email, password: PASSWORD, role, tenants } as never,
    overrideAccess: true,
  })

  const { token, user } = await payload.login({
    collection: 'users',
    data: { email, password: PASSWORD },
  })

  return { token: token!, user: user as unknown as { id: number } }
}

type CallOptions = { method?: string; tenant?: string; token?: null | string }

/** Drive a real HTTP request through Payload's own endpoint router. */
const call = async (path: string, { method = 'GET', tenant, token }: CallOptions = {}) => {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  const query = tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''

  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: INSTANCE_KEY,
    request: new Request(`http://localhost/api/xero${path}${query}`, { headers, method }),
  })

  const text = await response.text()
  let body: Record<string, any> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, any>) : null
  } catch {
    body = null
  }

  return { body, response, status: response.status }
}

const connect = (tenant?: string, options: CallOptions = {}) =>
  call('/connect', { ...options, tenant })
const callback = (query: string) => call(`/callback${query}`)

/** A state the server would have signed for this tenant's row. */
const goodState = async (tenant: Tenant, user: number) => {
  const settings = await settingsFor(tenant)
  if (!settings) throw new Error('connect first')

  return signOAuthState({
    secret: STATE_SECRET,
    state: { collection: 'users', settings: settings.id, tenant: tenant.id, user },
  })
}

/** A row whose access token has expired but whose refresh token is live. */
const expiredRow = async (tenant: Tenant, overrides: Record<string, unknown> = {}) => {
  const settings = (await settingsFor(tenant))!
  await saveXeroTokens({
    collection: 'xero-settings',
    encryptionKey: ENCRYPTION_KEY,
    payload,
    settings: settings as never,
    tokens: {
      accessToken: 'access-stale',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken: 'refresh-live-1',
      scope: null,
      ...overrides,
    } as never,
  })
  liveRefreshTokens.add('refresh-live-1')

  return (await findSettingsWithTokens({
    collection: 'xero-settings',
    id: settings.id,
    payload,
  }))!
}

const settingsFor = async (tenant: Tenant) => {
  const { docs } = await payload.find({
    collection: 'xero-settings',
    depth: 0,
    overrideAccess: true,
    showHiddenFields: true,
    where: { tenant: { equals: tenant.id } },
  })

  return docs[0] as unknown as Record<string, any> | undefined
}

describe('Xero OAuth endpoints', () => {
  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        'Set TEST_DATABASE_URL to a disposable Postgres database before running integration tests',
      )
    }

    config = await buildConfig({
      admin: { user: 'users' },
      auth: { passwordHashIterations: 100000 },
      collections: [Users, Tenants],
      db: postgresAdapter({
        pool: { connectionString: databaseUrl, max: 10 },
        push: true,
        schemaName: SCHEMA,
      }),
      plugins: [
        payloadXero({
          access: {
            create: tenantAdminAccess,
            delete: tenantAdminAccess,
            read: tenantAdminAccess,
            update: tenantAdminAccess,
          },
          oauth,
          scope: 'tenant',
        }),
        multiTenantPlugin({
          collections: { 'xero-settings': {} },
          tenantsArrayField: {
            rowFields: [
              {
                name: 'role',
                type: 'select',
                required: true,
                options: tenantRoleOptions,
                saveToJWT: true,
              },
            ],
          },
          tenantsSlug: 'tenants',
          userHasAccessToAllTenants: (user) => isSuperAdmin(user),
        }),
      ],
      secret: 'test-secret',
    })

    payload = await getPayload({ config, key: INSTANCE_KEY })

    tenantA = await createTenant('alpha')
    tenantB = await createTenant('bravo')
    adminA = await createUser(`admin-a-${runId}@example.invalid`, [
      { role: 'tenant-admin', tenant: tenantA.id },
    ])
    adminB = await createUser(`admin-b-${runId}@example.invalid`, [
      { role: 'tenant-admin', tenant: tenantB.id },
    ])
    editorA = await createUser(`editor-a-${runId}@example.invalid`, [
      { role: 'editor', tenant: tenantA.id },
    ])
    superAdmin = await createUser(`super-${runId}@example.invalid`, [], 'super-admin')
  })

  afterAll(async () => {
    if (!payload) return

    await payload.db.drizzle.execute(sql.raw(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`))
    await payload.destroy()
  })

  describe('connect', () => {
    it('refuses anonymous callers and non-admins', async () => {
      const anonymous = await connect(tenantA.slug)
      expect(anonymous.status).toBe(401)
      expect(anonymous.body?.error.code).toBe('not_authenticated')

      const editor = await connect(tenantA.slug, { token: editorA.token })
      expect(editor.status).toBe(403)
      expect(editor.body?.error.code).toBe('not_authorised')
    })

    it('refuses to start a connection for another tenant', async () => {
      const foreign = await createTenant('bravo-two')
      const result = await connect(foreign.slug, { token: adminA.token })

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
      expect(await settingsFor(foreign)).toBeUndefined()
    })

    it('does not create a settings row when access is refused', async () => {
      const fresh = await createTenant('charlie')

      expect((await connect(fresh.slug, { token: adminA.token })).status).toBe(403)

      const { totalDocs } = await payload.find({
        collection: 'xero-settings',
        overrideAccess: true,
        where: { tenant: { equals: fresh.id } },
      })
      expect(totalDocs).toBe(0)
    })

    it('creates the tenant’s settings row and redirects to Xero with the scopes', async () => {
      const result = await connect(tenantA.slug, { token: adminA.token })

      expect(result.status).toBe(302)
      const location = result.response.headers.get('location') ?? ''
      const url = new URL(location)

      expect(url.origin + url.pathname).toBe('https://login.xero.com/identity/connect/authorize')
      expect(url.searchParams.get('client_id')).toBe('xero-client-id')
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
      expect(url.searchParams.get('scope')?.split(' ')).toEqual([...XERO_OAUTH_SCOPES])

      const settings = await settingsFor(tenantA)
      expect(settings).toMatchObject({ tenant: tenantA.id })
      expect(result.response.headers.get('cache-control')).toBe('no-store')
    })

    it('accepts a tenant id as well as a slug', async () => {
      const result = await connect(String(tenantA.id), { token: adminA.token })

      expect(result.status).toBe(302)
    })

    it('needs a tenant in tenant scope', async () => {
      const result = await call('/connect', { token: adminA.token })

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('invalid_request')
    })

    it('lets a super-admin connect any tenant', async () => {
      const fresh = await createTenant('delta')
      const result = await connect(fresh.slug, { token: superAdmin.token })

      expect(result.status).toBe(302)
    })
  })

  describe('callback', () => {
    beforeAll(async () => {
      // Tenant B has no row yet; its own admin starts a connection, which is what creates it.
      expect((await connect(tenantB.slug, { token: adminB.token })).status).toBe(302)
    })

    it('finishes the connection: tokens, organisation ID and redirect', async () => {
      connections = [
        { tenantId: 'practice-1', tenantName: 'Practice', tenantType: 'PRACTICEMANAGER' },
        { tenantId: 'org-vwok', tenantName: 'Vanuatu Wok', tenantType: 'ORGANISATION' },
      ]
      const state = await goodState(tenantA, adminA.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(302)
      expect(result.response.headers.get('location')).toBe(
        `/admin/collections/xero-settings/${(await settingsFor(tenantA))!.id}?xero=connected`,
      )

      const settings = (await settingsFor(tenantA))!
      expect(settings).toMatchObject({ xeroTenantId: 'org-vwok' })
      expect(settings.connectedAt).toEqual(expect.any(String))
      // Stored encrypted: the plaintext tokens are nowhere on the row.
      expect(JSON.stringify(settings)).not.toContain('access-')
      expect(settings.tokens.accessToken).toMatch(/^v1\./)
      expect(settings.tokens.refreshToken).toMatch(/^v1\./)
      expect(settings.tokens.expiresAt).toEqual(expect.any(String))
    })

    it('never exposes the tokens through the API', async () => {
      const { docs } = await payload.find({
        collection: 'xero-settings',
        overrideAccess: false,
        user: { collection: 'users', ...adminA.user, tenants: [{ role: 'tenant-admin', tenant: tenantA.id }] } as never,
      })

      expect(docs[0]).toBeDefined()
      expect(docs[0]).not.toHaveProperty('tokens')
      expect(JSON.stringify(docs[0])).not.toContain('v1.')
    })

    it('refuses a forged or tampered state', async () => {
      const state = await goodState(tenantB, adminB.user.id)
      const [version, body] = state.split('.')

      const tampered = `${version}.${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
      const result = await callback(`?code=good-code&state=${encodeURIComponent(tampered)}`)

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('invalid_state')
      expect((await settingsFor(tenantB))?.tokens?.accessToken ?? null).toBeNull()
    })

    it('refuses a state signed with a different secret', async () => {
      const state = await signOAuthState({
        secret: 'not-the-payload-secret',
        state: {
          collection: 'users',
          settings: (await settingsFor(tenantB))!.id,
          tenant: tenantB.id,
          user: adminB.user.id,
        },
      })

      expect((await callback(`?code=good-code&state=${encodeURIComponent(state)}`)).status).toBe(400)
    })

    it('refuses a correctly signed state whose user belongs to another tenant', async () => {
      const state = await goodState(tenantA, adminB.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
      expect((await settingsFor(tenantA))?.xeroTenantId).toBe('org-vwok')
    })

    it('refuses a state whose user may not manage that tenant', async () => {
      // Signed correctly (only the server can do that), but the user is an editor of A.
      const state = await goodState(tenantA, editorA.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
    })

    it('surfaces Xero’s code refusal without storing anything', async () => {
      const state = await goodState(tenantB, adminB.user.id)

      const result = await callback(`?code=expired-code&state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(502)
      expect(result.body?.error.code).toBe('token_request_failed')
      expect(result.body?.error.message).toContain('invalid_grant')
      expect((await settingsFor(tenantB))?.tokens?.accessToken ?? null).toBeNull()
    })

    it('reports a cancelled connection', async () => {
      const result = await callback('?error=access_denied')

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('access_denied')
    })

    it('needs a code', async () => {
      const state = await goodState(tenantB, adminB.user.id)
      const result = await callback(`?state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('invalid_request')
    })

    it('fails when Xero lists no organisation', async () => {
      connections = [{ tenantId: 'practice-1', tenantName: 'Practice', tenantType: 'PRACTICEMANAGER' }]
      const state = await goodState(tenantB, adminB.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`)

      expect(result.status).toBe(502)
      expect(result.body?.error.code).toBe('no_organisation')
    })

    it('completes a connecting tenant a second time, replacing the tokens', async () => {
      connections = [{ tenantId: 'org-vwok', tenantName: 'Vanuatu Wok', tenantType: 'ORGANISATION' }]
      const first = await settingsFor(tenantB)
      const state = await goodState(tenantB, adminB.user.id)

      expect((await callback(`?code=good-code&state=${encodeURIComponent(state)}`)).status).toBe(302)

      const second = await settingsFor(tenantB)
      expect(second?.id).toBe(first?.id)
      expect(second?.tokens.accessToken).not.toBe(first?.tokens.accessToken)
    })
  })

  describe('refresh endpoint', () => {
    it('refreshes a stale tenant token and reports only the expiry', async () => {
      const settings = (await settingsFor(tenantB))!
      await saveXeroTokens({
        collection: 'xero-settings',
        encryptionKey: ENCRYPTION_KEY,
        payload,
        settings: settings as never,
        tokens: {
          accessToken: 'access-stale',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          refreshToken: 'refresh-endpoint-1',
          scope: null,
        },
      })
      liveRefreshTokens.add('refresh-endpoint-1')
      xeroCalls.length = 0

      const result = await call('/refresh', {
        method: 'POST',
        tenant: tenantB.slug,
        token: adminB.token,
      })

      expect(result.status).toBe(200)
      expect(result.body).toEqual({ expiresAt: expect.any(String), refreshed: true })
      expect(JSON.stringify(result.body)).not.toContain('access-')
      expect(xeroCalls[0].body?.grant_type).toBe('refresh_token')
    })

    it('says not_connected for a tenant that never connected', async () => {
      const fresh = await createTenant('foxtrot')
      await payload.create({
        collection: 'xero-settings',
        data: { tenant: fresh.id },
        overrideAccess: true,
      })

      const result = await call('/refresh', {
        method: 'POST',
        tenant: fresh.slug,
        token: superAdmin.token,
      })

      expect(result.status).toBe(409)
      expect(result.body?.error.code).toBe('not_connected')
    })

    it('keeps other tenants out', async () => {
      const result = await call('/refresh', {
        method: 'POST',
        tenant: tenantB.slug,
        token: adminA.token,
      })

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
    })
  })

  describe('access token refresh', () => {
    it('returns a live access token without calling Xero', async () => {
      const settings = (await settingsFor(tenantA))! as never
      xeroCalls.length = 0

      const { accessToken, refreshed } = await getXeroAccessToken({
        collection: 'xero-settings',
        oauth,
        payload,
        settings,
      })

      expect(refreshed).toBe(false)
      expect(accessToken).toMatch(/^access-/)
      expect(xeroCalls).toHaveLength(0)
    })

    it('refreshes an expired token, rotates the refresh token and stores both', async () => {
      const settings = await expiredRow(tenantA)
      xeroCalls.length = 0

      const first = await getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })

      expect(first.refreshed).toBe(true)
      expect(first.accessToken).toMatch(/^access-/)
      expect(xeroCalls).toHaveLength(1)
      expect(xeroCalls[0].body).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-live-1',
      })

      const stored = (await settingsFor(tenantA))!
      const decryptedAgain = await getXeroAccessToken({
        collection: 'xero-settings',
        oauth,
        payload,
        settings: stored as never,
      })
      expect(decryptedAgain.refreshed).toBe(false)

      // The rotated refresh token is what a later refresh sends, so the old one is dead.
      xeroCalls.length = 0
      const later = await findSettingsWithTokens({
        collection: 'xero-settings',
        id: stored.id,
        payload,
      })
      expect(later?.tokens?.refreshToken).not.toBe(settings.tokens?.refreshToken)

      const refreshedAgain = await getXeroAccessToken({
        collection: 'xero-settings',
        oauth,
        payload,
        settings: {
          ...later!,
          tokens: { ...later!.tokens, expiresAt: new Date(Date.now() - 1000).toISOString() },
        },
      })
      expect(refreshedAgain.refreshed).toBe(true)
      expect(xeroCalls[0].body?.refresh_token).toMatch(/^refresh-\d+$/)
      expect(xeroCalls[0].body?.refresh_token).not.toBe('refresh-live-1')
    })

    it('says not_connected when the tenant never connected', async () => {
      const fresh = await createTenant('echo')
      const settings = (await payload.create({
        collection: 'xero-settings',
        data: { tenant: fresh.id },
        overrideAccess: true,
      })) as unknown as { id: number }

      await expect(
        getXeroAccessToken({
          collection: 'xero-settings',
          oauth,
          payload,
          settings: settings as never,
        }),
      ).rejects.toMatchObject({ code: 'not_connected', status: 409 })
    })

    it('treats a token that will not decrypt as absent', async () => {
      const settings = (await settingsFor(tenantA))!
      // Written straight to the column, bypassing encryption: a key rotation or a copied row.
      await payload.update({
        collection: 'xero-settings',
        data: {
          tokens: {
            accessToken: 'v1.bm90LWEtcmVhbC1pdi5jaXBoZXJ0ZXh0',
            expiresAt: new Date(Date.now() - 1000).toISOString(),
            refreshToken: 'v1.bm90LWEtcmVhbC1pdi5jaXBoZXJ0ZXh0',
          },
        },
        id: settings.id,
        overrideAccess: true,
      })
      const unreadable = (await findSettingsWithTokens({
        collection: 'xero-settings',
        id: settings.id,
        payload,
      }))!

      await expect(
        getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings: unreadable }),
      ).rejects.toMatchObject({ code: 'not_connected' })
    })

    it('refuses to refresh without the encryption key', async () => {
      const settings = (await settingsFor(tenantA))! as never

      await expect(
        getXeroAccessToken({
          collection: 'xero-settings',
          oauth: { ...oauth, encryptionKey: undefined },
          payload,
          settings,
        }),
      ).rejects.toThrow('XERO_TOKEN_ENCRYPTION_KEY')
    })
  })
})
