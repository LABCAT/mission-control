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
import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { generateEncryptionKey } from './crypto'
import { payloadXero } from './index'
import { signOAuthState, verifyOAuthState, XERO_OAUTH_SCOPES } from './oauth'
import { getXeroAccessToken, findSettingsWithTokens, saveXeroTokens } from './token-store'
import { tenantAdminAccess, tenantRoleOptions, isSuperAdmin, superAdminAccess } from './test/roles'

const databaseUrl = process.env.TEST_DATABASE_URL
const SCHEMA = 'xero_oauth_test'
const INSTANCE_KEY = 'xero-oauth-test'
const PASSWORD = 'correct horse battery'
const STATE_SECRET = 'xero-oauth-state-secret'
/** The nonce a `goodState` carries, and the cookie a matching browser sends. */
const NONCE = 'browser-nonce-1'
const ENCRYPTION_KEY = generateEncryptionKey()
/** Users who may read the settings row but not replace its connection. */
const readOnlyEmails = new Set<string>()
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

/**
 * Holds refresh token exchanges inside Xero until the test releases them, so two refreshes can
 * genuinely overlap instead of running one after the other in a single tick.
 */
let refreshGate: null | { release: () => void; wait: Promise<void> } = null

const openRefreshGate = (): (() => void) => {
  const gate: { release: () => void; wait: Promise<void> } = {
    release: () => {},
    wait: Promise.resolve(),
  }

  gate.wait = new Promise<void>((resolve) => {
    gate.release = resolve
  })
  refreshGate = gate

  return gate.release
}

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

      if (refreshGate) await refreshGate.wait
      // Re-check after the gate: a token spent while this call was suspended is dead.
      if (!liveRefreshTokens.has(body.refresh_token)) {
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

type CallOptions = { cookie?: null | string; method?: string; tenant?: string; token?: null | string }

/** Drive a real HTTP request through Payload's own endpoint router. */
const call = async (path: string, { cookie, method = 'GET', tenant, token }: CallOptions = {}) => {
  const headers = new Headers()
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (cookie) headers.set('cookie', cookie)
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

/** The connect nonce cookie a browser would keep, parsed off the 302 to Xero. */
const nonceCookieOf = (response: Response): null | string => {
  const header = response.headers.get('set-cookie')
  const match = header?.match(/xero_oauth=([^;]*)/)

  return match ? `xero_oauth=${match[1]}` : null
}

/** `/connect`, returning the state it signed and the cookie the initiating browser would hold. */
const beginConnect = async (tenant: string, options: CallOptions = {}) => {
  const response = await connect(tenant, options)
  const location = response.response.headers.get('location')
  if (!location) throw new Error(`connect did not redirect (${response.status})`)

  return {
    cookie: nonceCookieOf(response.response),
    state: new URL(location).searchParams.get('state')!,
  }
}

const callback = (query: string, options: CallOptions = {}) =>
  call(`/callback${query}`, options)

/** A state the server would have signed for this tenant's row. */
const goodState = async (
  tenant: Tenant,
  user: number,
  { nonce = NONCE }: { nonce?: string } = {},
) => {
  const settings = await settingsFor(tenant)
  if (!settings) throw new Error('connect first')

  return signOAuthState({
    secret: STATE_SECRET,
    state: { collection: 'users', nonce, settings: settings.id, tenant: tenant.id, user },
  })
}

/** The cookie a browser that started the flow would send back with `goodState`. */
const GOOD_COOKIE = `xero_oauth=${NONCE}`

/** A row whose access token has expired but whose refresh token is live. */
const expiredRow = async (tenant: Tenant, overrides: Record<string, unknown> = {}) => {
  const settings = (await settingsFor(tenant))!
  const refreshToken = (overrides.refreshToken as string | undefined) ?? 'refresh-live-1'

  await saveXeroTokens({
    collection: 'xero-settings',
    encryptionKey: ENCRYPTION_KEY,
    payload,
    settings: settings as never,
    tokens: {
      accessToken: 'access-stale',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      refreshToken,
      scope: null,
      ...overrides,
    } as never,
  })
  liveRefreshTokens.add(refreshToken)

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
            // Read and update deliberately differ, so the suite can prove a caller who may
            // only read cannot replace an existing connection.
            update: (args) => {
              const user = args.req.user as null | { email?: string }

              return user?.email && readOnlyEmails.has(user.email) ? false : tenantAdminAccess(args)
            },
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

  /**
   * The rest of the suite drives Payload's router in-process. This block proves the same flow
   * over a real socket, with real HTTP semantics: a browser follows redirects, keeps the nonce
   * cookie, and sends it back with the cross-site callback. A response-object test cannot catch a
   * cookie that is set but not honoured, or a redirect the browser would refuse.
   */
  describe('over real HTTP', () => {
    let server: Server
    let base: string

    beforeAll(async () => {
      server = createServer(async (request, response) => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers.set(name, value)
        }

        const result = await handleEndpoints({
          config,
          payloadInstanceCacheKey: INSTANCE_KEY,
          request: new Request(`${base}${request.url}`, {
            headers,
            method: request.method,
          }),
        })

        const setCookie = result.headers.get('set-cookie')
        response.writeHead(result.status, {
          ...(setCookie ? { 'set-cookie': setCookie } : {}),
          'cache-control': result.headers.get('cache-control') ?? 'no-store',
          location: result.headers.get('location') ?? '',
        })
        response.end(await result.text())
      })

      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve)
      })

      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      base = `http://127.0.0.1:${address.port}`
    })

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    })

    it('runs connect → Xero → callback with the cookie and never leaks the token', async () => {
      connections = [{ tenantId: 'org-http', tenantName: 'HTTP Practice', tenantType: 'ORGANISATION' }]
        const tenant = await createTenant('golf')
        const admin = await createUser(`admin-golf-${runId}@example.invalid`, [
        { role: 'tenant-admin', tenant: tenant.id },
      ])
  
      // 1. The admin clicks connect. Manual redirect so the 302 to Xero can be inspected.
        const started = await fetch(`${base}/api/xero/connect?tenant=${tenant.slug}`, {
        headers: { authorization: `Bearer ${admin.token}` },
        redirect: 'manual',
      })
  
      expect(started.status).toBe(302)
      const xeroURL = new URL(started.headers.get('location')!)
      expect(xeroURL.origin + xeroURL.pathname).toBe('https://login.xero.com/identity/connect/authorize')

      const setCookie = started.headers.get('set-cookie')!
      const cookie = setCookie.split(';')[0]
      expect(cookie).toMatch(/^xero_oauth=/)
      // A browser will not send this cookie to another site, which is the point of binding it.
      expect(setCookie).toContain('SameSite=Lax')

      const state = xeroURL.searchParams.get('state')!

      // 2. The browser returns to our callback with that cookie, exactly as it would from Xero.
      const finished = await fetch(
        `${base}/api/xero/callback?code=good-code&state=${encodeURIComponent(state)}`,
        { headers: { cookie }, redirect: 'manual' },
      )

      expect(finished.status).toBe(302)
      expect(finished.headers.get('location')).toMatch(
        new RegExp(`^/admin/collections/xero-settings/\\d+\\?xero=connected$`),
      )

      const row = await settingsFor(tenant)
      expect(row?.xeroTenantId).toBe('org-http')
      expect(row?.tokens?.accessToken).toEqual(expect.any(String))
      // Ciphertext only: the plaintext token is nowhere on the row.
      expect(JSON.stringify(row)).not.toContain('access-http')

      // 3. The refresh endpoint answers over HTTP and still never returns a token.
      const refreshed = await fetch(`${base}/api/xero/refresh?tenant=${tenant.slug}`, {
        headers: { authorization: `Bearer ${admin.token}` },
        method: 'POST',
      })

      expect(refreshed.status).toBe(200)
      const body = (await refreshed.json()) as Record<string, unknown>
      // No token of any kind: the caller only learns whether it refreshed, and when it expires.
      expect(body).toHaveProperty('expiresAt')
      expect(body).toHaveProperty('refreshed')
      expect(Object.keys(body)).toHaveLength(2)
    })

    it('refuses the callback over HTTP when the browser has no nonce cookie', async () => {
      const tenant = await createTenant('hotel')
      const admin = await createUser(`admin-hotel-${runId}@example.invalid`, [
        { role: 'tenant-admin', tenant: tenant.id },
      ])

      const started = await fetch(`${base}/api/xero/connect?tenant=${tenant.slug}`, {
        headers: { authorization: `Bearer ${admin.token}` },
        redirect: 'manual',
      })
      const state = new URL(started.headers.get('location')!).searchParams.get('state')!

      // The victim's browser follows an attacker-supplied link; it holds no matching cookie.
      const refused = await fetch(
        `${base}/api/xero/callback?code=good-code&state=${encodeURIComponent(state)}`,
        { redirect: 'manual' },
      )

      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('invalid_state')
      expect((await settingsFor(tenant))?.xeroTenantId ?? null).toBeNull()
    })

    it('answers 401 over HTTP for an anonymous connect', async () => {
      const response = await fetch(`${base}/api/xero/connect?tenant=any`, { redirect: 'manual' })

      expect(response.status).toBe(401)
    })
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

    it('binds the flow to this browser with a nonce cookie that the state repeats', async () => {
      const { cookie, state } = await beginConnect(tenantA.slug, { token: adminA.token })

      expect(cookie).toMatch(/^xero_oauth=[0-9a-f-]{36}$/)
      const setCookie = (await connect(tenantA.slug, { token: adminA.token })).response.headers.get(
        'set-cookie',
      )
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Path=/')

      // The state carries the same value, which the callback compares against the cookie.
      const verified = await verifyOAuthState({ secret: STATE_SECRET, token: state })
      expect(cookie).toBe(`xero_oauth=${verified.nonce}`)
    })

    it('gives each connect attempt its own nonce', async () => {
      const first = await beginConnect(tenantA.slug, { token: adminA.token })
      const second = await beginConnect(tenantA.slug, { token: adminA.token })

      expect(first.cookie).not.toBe(second.cookie)
      expect(first.state).not.toBe(second.state)
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

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

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
      const result = await callback(`?code=good-code&state=${encodeURIComponent(tampered)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('invalid_state')
      expect((await settingsFor(tenantB))?.tokens?.accessToken ?? null).toBeNull()
    })

    it('refuses a state signed with a different secret', async () => {
      const state = await signOAuthState({
        secret: 'not-the-payload-secret',
        state: {
          collection: 'users',
          nonce: NONCE,
          settings: (await settingsFor(tenantB))!.id,
          tenant: tenantB.id,
          user: adminB.user.id,
        },
      })

      expect((await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })).status).toBe(400)
    })

    it('refuses a correctly signed state whose user belongs to another tenant', async () => {
      const state = await goodState(tenantA, adminB.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
      expect((await settingsFor(tenantA))?.xeroTenantId).toBe('org-vwok')
    })

    it('refuses a state whose user may not manage that tenant', async () => {
      // Signed correctly (only the server can do that), but the user is an editor of A.
      const state = await goodState(tenantA, editorA.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(403)
      expect(result.body?.error.code).toBe('not_authorised')
    })

    it('surfaces Xero’s code refusal without storing anything', async () => {
      const state = await goodState(tenantB, adminB.user.id)

      const result = await callback(`?code=expired-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(502)
      expect(result.body?.error.code).toBe('token_request_failed')
      expect(result.body?.error.message).toContain('invalid_grant')
      expect((await settingsFor(tenantB))?.tokens?.accessToken ?? null).toBeNull()
    })

    it('refuses a state the returning browser did not start', async () => {
      // An attacker signs a state for their own row and hands the victim the Xero URL; the
      // victim's browser has no matching cookie, so the callback refuses it.
      const state = await goodState(tenantA, adminA.user.id)

      const missing = await callback(`?code=good-code&state=${encodeURIComponent(state)}`)
      expect(missing.status).toBe(400)
      expect(missing.body?.error.code).toBe('invalid_state')

      const wrongBrowser = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, {
        cookie: 'xero_oauth=another-browser',
      })
      expect(wrongBrowser.status).toBe(400)
      expect(wrongBrowser.body?.error.code).toBe('invalid_state')

      // Neither attempt touched the tenant's tokens.
      expect((await settingsFor(tenantA))?.tokens?.accessToken ?? null).not.toBeNull()
    })

    it('completes a browser-driven connect: cookie, state and tokens line up', async () => {
      connections = [{ tenantId: 'org-vwok', tenantName: 'Vanuatu Wok', tenantType: 'ORGANISATION' }]
      const { cookie, state } = await beginConnect(tenantB.slug, { token: adminB.token })

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie })

      expect(result.status).toBe(302)
      // The nonce is single-use in the sense that the cookie is cleared on the way back.
      expect(result.response.headers.get('set-cookie')).toContain('Max-Age=0')
      expect((await settingsFor(tenantB))?.xeroTenantId).toBe('org-vwok')
    })

    it('reports a cancelled connection', async () => {
      const result = await callback('?error=access_denied')

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('access_denied')
    })

    it('needs a code', async () => {
      const state = await goodState(tenantB, adminB.user.id)
      const result = await callback(`?state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(400)
      expect(result.body?.error.code).toBe('invalid_request')
    })

    it('fails when Xero lists no organisation', async () => {
      connections = [{ tenantId: 'practice-1', tenantName: 'Practice', tenantType: 'PRACTICEMANAGER' }]
      const state = await goodState(tenantB, adminB.user.id)

      const result = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })

      expect(result.status).toBe(502)
      expect(result.body?.error.code).toBe('no_organisation')
    })

    it('completes a connecting tenant a second time, replacing the tokens', async () => {
      connections = [{ tenantId: 'org-vwok', tenantName: 'Vanuatu Wok', tenantType: 'ORGANISATION' }]
      const first = await settingsFor(tenantB)
      const state = await goodState(tenantB, adminB.user.id)

      expect((await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie: GOOD_COOKIE })).status).toBe(302)

      const second = await settingsFor(tenantB)
      expect(second?.id).toBe(first?.id)
      expect(second?.tokens.accessToken).not.toBe(first?.tokens.accessToken)
    })

    it('refuses to replace a connection when the caller may read but not update', async () => {
      connections = [{ tenantId: 'org-readonly', tenantName: 'Read Only', tenantType: 'ORGANISATION' }]
      const reader = await createUser(`reader-${runId}@example.invalid`, [
        { role: 'tenant-admin', tenant: tenantA.id },
      ])
      readOnlyEmails.add(`reader-${runId}@example.invalid`)

      const before = await settingsFor(tenantA)
      const { cookie, state } = await beginConnect(tenantA.slug, { token: reader.token })
      const xeroCallsBefore = xeroCalls.length

      const refused = await callback(`?code=good-code&state=${encodeURIComponent(state)}`, { cookie })

      expect(refused.status).toBe(403)
      expect(refused.body?.error.code).toBe('not_authorised')
      // The code was never spent: authorisation is checked before Xero is called.
      expect(xeroCalls.length).toBe(xeroCallsBefore)

      const after = await settingsFor(tenantA)
      expect(after?.xeroTenantId ?? null).toBe(before?.xeroTenantId ?? null)
      expect(after?.tokens.accessToken).toBe(before?.tokens.accessToken)

      readOnlyEmails.delete(`reader-${runId}@example.invalid`)
    })

    it('refuses a refresh for a caller who may read but not update', async () => {
      // Own tenant, so this cannot disturb the token state other tests share.
      const tenant = await createTenant(`readonly-${runId}`)
      const reader = await createUser(`reader-refresh-${runId}@example.invalid`, [
        { role: 'tenant-admin', tenant: tenant.id },
      ])
      readOnlyEmails.add(`reader-refresh-${runId}@example.invalid`)

      const admin = await createUser(`owner-${runId}@example.invalid`, [
        { role: 'tenant-admin', tenant: tenant.id },
      ])
      await beginConnect(tenant.slug, { token: admin.token })
      const settings = (await settingsFor(tenant))!
      await saveXeroTokens({
        collection: 'xero-settings',
        encryptionKey: ENCRYPTION_KEY,
        payload,
        settings: settings as never,
        tokens: {
          accessToken: 'access-stale',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          refreshToken: 'refresh-readonly',
          scope: null,
        } as never,
      })

      const before = (await settingsFor(tenant))?.tokens.refreshToken
      const xeroCallsBefore = xeroCalls.length

      const refused = await call('/refresh', { method: 'POST', tenant: tenant.slug, token: reader.token })

      expect(refused.status).toBe(403)
      expect(refused.body?.error.code).toBe('not_authorised')
      expect(xeroCalls.length).toBe(xeroCallsBefore)
      // The refresh token is not spent on a caller who cannot write the result back.
      expect((await settingsFor(tenant))?.tokens.refreshToken).toBe(before)

      readOnlyEmails.delete(`reader-refresh-${runId}@example.invalid`)
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

    it('does not let a request whose lease lapsed overwrite a newer token pair', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-slow-1' })
      xeroCalls.length = 0

      const release = openRefreshGate()
      try {
        const slow = getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })

        // Let the slow request take the lease and reach Xero.
        await new Promise((resolve) => setTimeout(resolve, 300))

        // A peer takes the lease over, as it would once the slow request's lease lapsed, and
        // stores the pair Xero gave it.
        const peerSettings = await findSettingsWithTokens({
          collection: 'xero-settings',
          id: settings.id,
          payload,
        })
        await payload.db.updateOne({
          collection: 'xero-settings',
          data: { tokens: { refreshLockToken: 'peer-lease', refreshLockedUntil: Date.now() + 60_000 } },
          where: { id: { equals: settings.id } },
        })
        await saveXeroTokens({
          collection: 'xero-settings',
          encryptionKey: ENCRYPTION_KEY,
          payload,
          settings: peerSettings as never,
          tokens: {
            accessToken: 'access-peer',
            expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            refreshToken: 'refresh-peer',
            scope: null,
          },
        })

        release()

        // The slow request's pair is stale by then, so it reports failure rather than writing.
        await expect(slow).rejects.toMatchObject({ code: 'refresh_failed' })

        const stored = await findSettingsWithTokens({
          collection: 'xero-settings',
          id: settings.id,
          payload,
        })
        const winner = await getXeroAccessToken({
          collection: 'xero-settings',
          oauth,
          payload,
          settings: stored as never,
        })
        expect(winner.accessToken).toBe('access-peer')
        expect(winner.refreshed).toBe(false)
      } finally {
        release()
      }
    })

    it('gives up on a token request that outlives its deadline, and frees the lease', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-hang-1' })

      // A Xero that never answers, but honours the abort signal the client sets.
      const hangingOauth = {
        ...oauth,
        fetch: ((_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('timed out')
              error.name = 'TimeoutError'
              reject(error)
            })
          })) as unknown as typeof fetch,
        tokenRequestTimeoutMs: 50,
      }

      await expect(
        getXeroAccessToken({ collection: 'xero-settings', oauth: hangingOauth, payload, settings }),
      ).rejects.toMatchObject({ code: 'refresh_failed', status: 502 })

      // The lease is handed back, so a later request is not locked out.
      const after = await findSettingsWithTokens({
        collection: 'xero-settings',
        id: settings.id,
        payload,
      })
      expect(after?.tokens?.refreshLockToken ?? null).toBeNull()
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

    it('refreshes once when two requests race on the same expired token', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-race-1' })
      xeroCalls.length = 0

      // Hold Xero's answer so both requests are in flight before either one saves.
      const release = openRefreshGate()
      try {
        const both = Promise.all([
          getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings }),
          getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings }),
        ])

        // Let the winner reach Xero and the loser bounce off the lease.
        await new Promise((resolve) => setTimeout(resolve, 300))
        release()

        const results = await both

        // Exactly one request spent the rotating refresh token.
        const refreshCalls = xeroCalls.filter((c) => c.body?.grant_type === 'refresh_token')
        expect(refreshCalls).toHaveLength(1)
        expect(refreshCalls[0].body?.refresh_token).toBe('refresh-race-1')

        // Both callers get a usable token: one refreshed it, the other read the winner's.
        expect(results.map((result) => result.accessToken)).toEqual([
          expect.stringMatching(/^access-/),
          expect.stringMatching(/^access-/),
        ])
        // One refreshed it; the other read the result.
        expect(results.filter((result) => result.refreshed)).toHaveLength(1)
      } finally {
        refreshGate = null
      }

      // The winner's rotation was persisted exactly once, so a later refresh uses the new token.
      const stored = (await settingsFor(tenantA))!
      expect(stored.tokens.refreshLockToken ?? null).toBeNull()
      expect(stored.tokens.refreshLockedUntil ?? null).toBeNull()

      xeroCalls.length = 0
      const later = await getXeroAccessToken({
        collection: 'xero-settings',
        oauth,
        payload,
        settings: {
          ...(await findSettingsWithTokens({ collection: 'xero-settings', id: stored.id, payload }))!,
          tokens: {
            ...(stored as never as { tokens: Record<string, unknown> }).tokens,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
      })
      expect(later.refreshed).toBe(true)
      expect(xeroCalls[0].body?.refresh_token).not.toBe('refresh-race-1')
    })

    it('does not spend a token a peer has already rotated', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-stale-read' })
      xeroCalls.length = 0

      // Another request refreshes and saves first, leaving no lease behind.
      const winner = await getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })
      const rotated = (await settingsFor(tenantA))!
      expect(rotated.tokens.refreshToken).not.toBe(settings.tokens?.refreshToken)

      // This caller still holds the row as it was before that save: an expired access token and
      // the refresh token that has already been spent. It must not send that token to Xero.
      xeroCalls.length = 0
      const loser = await getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })

      expect(xeroCalls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(0)
      expect(loser.refreshed).toBe(false)
      expect(loser.accessToken).toBe(winner.accessToken)
    })

    it('refreshes once when many requests race', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-race-many' })
      xeroCalls.length = 0

      const release = openRefreshGate()
      try {
        const all = Promise.all(
          Array.from({ length: 5 }, () =>
            getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings }),
          ),
        )

        await new Promise((resolve) => setTimeout(resolve, 300))
        release()

        const results = await all
        expect(xeroCalls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(1)
        expect(results.every((result) => result.accessToken.startsWith('access-'))).toBe(true)
        expect(results.filter((result) => result.refreshed)).toHaveLength(1)
      } finally {
        refreshGate = null
      }
    })

    it('hands the lease back when Xero refuses the refresh', async () => {
      // The stored refresh token is not one Xero will accept, so the call fails.
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-dead' })
      liveRefreshTokens.delete('refresh-dead')
      xeroCalls.length = 0

      await expect(
        getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings }),
      ).rejects.toMatchObject({ code: 'refresh_failed' })

      const stored = (await settingsFor(tenantA))!
      expect(stored.tokens.refreshLockToken ?? null).toBeNull()
      expect(stored.tokens.refreshLockedUntil ?? null).toBeNull()
    })

    it('takes over a lease left behind by a request that died', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-orphan' })
      xeroCalls.length = 0

      // A lease in the past is nobody's: the next refresh must not wait for it.
      await payload.update({
        collection: 'xero-settings',
        data: { tokens: { refreshLockToken: 'gone', refreshLockedUntil: Date.now() - 1000 } },
        id: settings.id,
        overrideAccess: true,
      })

      const result = await getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })

      expect(result.refreshed).toBe(true)
      expect(xeroCalls.filter((c) => c.body?.grant_type === 'refresh_token')).toHaveLength(1)
    })

    it('leaves the tokens out of the API when a refresh happens', async () => {
      const settings = await expiredRow(tenantA, { refreshToken: 'refresh-hidden' })
      await getXeroAccessToken({ collection: 'xero-settings', oauth, payload, settings })

      const { docs } = await payload.find({
        collection: 'xero-settings',
        overrideAccess: false,
        user: {
          collection: 'users',
          ...adminA.user,
          tenants: [{ role: 'tenant-admin', tenant: tenantA.id }],
        } as never,
      })

      expect(docs[0]).not.toHaveProperty('tokens')
      expect(JSON.stringify(docs[0])).not.toContain('v1.')
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
