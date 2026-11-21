/**
 * The `/api/xero/connect` and `/api/xero/callback` endpoints, per tenant.
 *
 * Flow:
 *
 * 1. A tenant admin opens `/api/xero/connect?tenant=<id or slug>`. The endpoint finds (or
 *    creates) that tenant's settings row **as that user**, so the tenancy layer decides
 *    whether they may connect it. It then redirects to Xero with a signed `state` carrying
 *    the settings row, the tenant and the user.
 * 2. Xero redirects the browser to `/api/xero/callback?code=…&state=…`. That is a cross-site
 *    navigation, so the admin's session cookie is not sent; the signature on the state is
 *    what authenticates the request. The endpoint re-checks the user's access to the row,
 *    trades the code for tokens, records the organisation ID, stores the encrypted tokens,
 *    and redirects back to the settings row in the admin.
 *
 * Using `fetch` only, so this runs unchanged on Cloudflare Workers.
 */

import type { CollectionSlug, Endpoint, Payload, PayloadRequest } from 'payload'
import { formatAdminURL } from 'payload/shared'

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  fetchXeroConnections,
  resolveXeroOAuth,
  signOAuthState,
  verifyOAuthState,
  XERO_OAUTH_COOKIE,
  xeroOrganisationId,
  type XeroOAuthOptions,
  XeroOAuthError,
  type XeroTokenSet,
} from './oauth'
import {
  assertCanUpdateSettings,
  findSettingsWithTokens,
  getXeroAccessToken,
  saveXeroTokens,
  type XeroSettingsDoc,
} from './token-store'
import { DEFAULT_SETTINGS_SLUG, DEFAULT_TENANT_FIELD, type XeroScope } from './xero-settings'

export const DEFAULT_CONNECT_PATH = '/xero/connect'
export const DEFAULT_CALLBACK_PATH = '/xero/callback'
export const DEFAULT_REFRESH_PATH = '/xero/refresh'
export const DEFAULT_TENANTS_SLUG = 'tenants'

export type XeroOAuthEndpointOptions = {
  /** Path of the callback endpoint. Defaults to `/xero/callback`. Must match the Xero app. */
  callbackPath?: string
  /** Path of the connect endpoint. Defaults to `/xero/connect`. */
  connectPath?: string
  /** Path of the refresh endpoint. Defaults to `/xero/refresh`. */
  refreshPath?: string
  /** Credentials and HTTP client. Defaults read the `XERO_*` env vars. */
  oauth?: XeroOAuthOptions
  /** `global` (one settings row) or `tenant` (one per tenant, keyed by `tenantField`). */
  scope?: XeroScope
  /** Settings collection slug. Defaults to `xero-settings`. */
  settingsSlug?: string
  /** Tenant field added by the tenancy layer. Defaults to `tenant`. */
  tenantField?: string
  /** Tenants collection slug, used to resolve `?tenant=<slug>`. Defaults to `tenants`. */
  tenantsSlug?: string
}

type ResolvedEndpointOptions = Required<
  Omit<XeroOAuthEndpointOptions, 'oauth'>
> & {
  oauth: XeroOAuthOptions
}

const resolveOptions = (options: XeroOAuthEndpointOptions = {}): ResolvedEndpointOptions => ({
  callbackPath: options.callbackPath ?? DEFAULT_CALLBACK_PATH,
  connectPath: options.connectPath ?? DEFAULT_CONNECT_PATH,
  oauth: options.oauth ?? {},
  refreshPath: options.refreshPath ?? DEFAULT_REFRESH_PATH,
  scope: options.scope ?? 'global',
  settingsSlug: options.settingsSlug ?? DEFAULT_SETTINGS_SLUG,
  tenantField: options.tenantField ?? DEFAULT_TENANT_FIELD,
  tenantsSlug: options.tenantsSlug ?? DEFAULT_TENANTS_SLUG,
})

const noStore = (response: Response): Response => {
  response.headers.set('cache-control', 'no-store')

  return response
}

const errorResponse = (error: XeroOAuthError): Response =>
  noStore(
    Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    ),
  )

/** A redirect the browser follows (to Xero, or back to the admin). */
const redirectResponse = (location: string): Response =>
  noStore(new Response(null, { headers: { location }, status: 302 }))

/**
 * The callback is a cross-site top-level navigation and cannot rely on the admin's auth cookie,
 * so the signed state carries the identity. That alone would let an attacker start a flow on
 * their own row and hand the victim the Xero URL, linking the victim's Xero account to the
 * attacker's settings. A nonce set as a cookie here and echoed in the state ties the two ends
 * to the same browser.
 *
 * `SameSite=Lax` is what makes the cookie survive the return from Xero: the callback is a
 * top-level GET. The nonce is checked against the state, not used as a credential on its own.
 */
const nonceCookie = (nonce: string, maxAge: number): string =>
  `${XERO_OAUTH_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`

/** A cleared nonce cookie, for after the callback has consumed it. */
const clearedNonceCookie = (): string => `${XERO_OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

const cookieValue = (req: PayloadRequest, name: string): null | string => {
  const header = req.headers?.get('cookie')
  if (!header) return null

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }

  return null
}

/** Compare two secrets without leaking where they differ. */
const sameSecret = (a: null | string, b: null | string): boolean => {
  if (!a || !b || a.length !== b.length) return false

  let mismatch = 0
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index)

  return mismatch === 0
}

type RelationRef = null | number | string | { id: number | string } | undefined

const idOf = (value: RelationRef): null | number | string =>
  value === null || value === undefined ? null : typeof value === 'object' ? value.id : value

/** The unauthenticated callback still needs the admin's identity: the state carries it. */
const userFromState = async (
  payload: Payload,
  state: { collection: string; user: number | string },
): Promise<Record<string, unknown>> => {
  try {
    return (await payload.findByID({
      collection: state.collection as CollectionSlug,
      depth: 0,
      id: state.user,
      overrideAccess: true,
    })) as unknown as Record<string, unknown>
  } catch {
    throw new XeroOAuthError('not_authorised', 'The user who started this connection no longer exists.')
  }
}

/**
 * The settings row for a tenant, read as `user` so both the app's access rules and the
 * tenancy layer's constraints apply. `create` makes a missing row instead of 404ing.
 */
const settingsForUser = async ({
  create,
  options,
  payload,
  settingsID,
  tenantID,
  user,
}: {
  create: boolean
  options: ResolvedEndpointOptions
  /** Read this exact row instead of searching by tenant. */
  settingsID?: number | string
  payload: Payload
  tenantID: null | number | string
  user: Record<string, unknown>
}): Promise<XeroSettingsDoc> => {
  if (settingsID !== undefined) {
    let doc: XeroSettingsDoc
    try {
      doc = (await payload.findByID({
        collection: options.settingsSlug,
        depth: 0,
        id: settingsID,
        overrideAccess: false,
        user,
      } as never)) as unknown as XeroSettingsDoc
    } catch {
      // Forbidden (the access rules said no) and NotFound (another tenant's ID) look the same:
      // the caller must not learn that a row exists.
      throw new XeroOAuthError('not_authorised', 'You cannot manage Xero settings for this tenant.')
    }

    return doc
  }

  const where =
    options.scope === 'tenant' && tenantID !== null
      ? { [options.tenantField]: { equals: tenantID } }
      : undefined

  let existing: XeroSettingsDoc | undefined
  try {
    const found = await payload.find({
      collection: options.settingsSlug,
      depth: 0,
      limit: 1,
      overrideAccess: false,
      user,
      ...(where ? { where } : {}),
    } as never)
    existing = found.docs[0] as unknown as XeroSettingsDoc | undefined
  } catch {
    // Payload throws Forbidden when the app's access rules refuse the read.
    throw new XeroOAuthError('not_authorised', 'You cannot manage Xero settings for this tenant.')
  }

  if (existing) return existing

  if (!create) {
    throw new XeroOAuthError('not_authorised', 'You cannot manage Xero settings for this tenant.')
  }

  try {
    return (await payload.create({
      collection: options.settingsSlug,
      data: options.scope === 'tenant' ? { [options.tenantField]: tenantID } : {},
      overrideAccess: false,
      user,
    } as never)) as unknown as XeroSettingsDoc
  } catch {
    // Access rules and the tenancy layer both refuse this; the caller learns nothing more.
    throw new XeroOAuthError('not_authorised', 'You cannot manage Xero settings for this tenant.')
  }
}

/** `?tenant=` accepts a tenant ID or slug. Tenant scope needs one. */
const resolveTenantID = async ({
  options,
  payload,
  req,
}: {
  options: ResolvedEndpointOptions
  payload: Payload
  req: PayloadRequest
}): Promise<null | number | string> => {
  if (options.scope !== 'tenant') return null

  const raw = req.searchParams?.get('tenant')?.trim()
  if (!raw) {
    throw new XeroOAuthError('invalid_request', 'Pass ?tenant=<tenant id or slug> to connect a tenant.')
  }

  if (/^\d+$/.test(raw)) return raw

  // Tenant slugs are public (they drive the sites' domains), so looking the row up with
  // overrideAccess only turns "no such tenant" into a 404. Whether this user may manage it is
  // decided by the tenancy layer when the settings row is read or created.
  const result = await payload.find({
    collection: options.tenantsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { slug: { equals: raw } },
  })

  const tenant = result.docs[0] as unknown as { id: number | string } | undefined
  if (!tenant) throw new XeroOAuthError('invalid_request', 'Unknown tenant.')

  return tenant.id
}

/** A connection without a refresh token dies within the hour, so treat that as a failed one. */
const refreshTokenRequired = (tokens: XeroTokenSet): XeroTokenSet & { refreshToken: string } => {
  if (!tokens.refreshToken) {
    throw new XeroOAuthError(
      'invalid_response',
      'Xero did not return a refresh token. Check that the app requests offline_access.',
    )
  }

  return { ...tokens, refreshToken: tokens.refreshToken }
}

const requireUser = (req: PayloadRequest): Record<string, unknown> => {
  const user = req.user as Record<string, unknown> | null
  if (!user) throw new XeroOAuthError('not_authenticated', 'Sign in to the admin panel to connect Xero.')

  return user
}

const stateSecretOf = (req: PayloadRequest, options: ResolvedEndpointOptions): string => {
  const secret = resolveXeroOAuth(options.oauth).stateSecret ?? req.payload.secret

  if (!secret) throw new XeroOAuthError('not_configured', 'Xero OAuth needs a state secret.')

  return secret
}

/** GET /api/xero/connect?tenant=<id or slug> → 302 to Xero. */
export const xeroConnectHandler =
  (incoming: XeroOAuthEndpointOptions = {}) =>
  async (req: PayloadRequest): Promise<Response> => {
    const options = resolveOptions(incoming)

    try {
      const user = requireUser(req)
      const tenantID = await resolveTenantID({ options, payload: req.payload, req })
      const settings = await settingsForUser({
        create: true,
        options,
        payload: req.payload,
        tenantID,
        user,
      })

      const { stateTtlSeconds } = resolveXeroOAuth(options.oauth)
      const nonce = crypto.randomUUID()
      const state = await signOAuthState({
        secret: stateSecretOf(req, options),
        state: {
          collection: (user.collection as string | undefined) ?? req.payload.config.admin.user,
          nonce,
          settings: settings.id,
          tenant: tenantID,
          user: user.id as number | string,
        },
      })

      const response = redirectResponse(buildAuthorizeUrl(options.oauth, { state }))
      response.headers.append('set-cookie', nonceCookie(nonce, stateTtlSeconds))

      return response
    } catch (error) {
      if (error instanceof XeroOAuthError) return errorResponse(error)

      req.payload.logger.error({ err: error, msg: 'xero: connect failed' })

      return errorResponse(new XeroOAuthError('invalid_request', 'Could not start the Xero connection.'))
    }
  }

/** Where the admin lands after a successful connection. */
const settingsAdminURL = (req: PayloadRequest, settings: XeroSettingsDoc, slug: string): string => {
  const { admin: adminRoute } = req.payload.config.routes

  return formatAdminURL({
    adminRoute,
    path: `/collections/${slug}/${settings.id}?xero=connected`,
  })
}

/** GET /api/xero/callback?code=…&state=… → 302 back to the settings row. */
export const xeroCallbackHandler =
  (incoming: XeroOAuthEndpointOptions = {}) =>
  async (req: PayloadRequest): Promise<Response> => {
    const options = resolveOptions(incoming)

    try {
      const xeroError = req.searchParams?.get('error')
      if (xeroError) {
        throw new XeroOAuthError(
          xeroError === 'access_denied' ? 'access_denied' : 'token_request_failed',
          xeroError === 'access_denied'
            ? 'The Xero connection was cancelled.'
            : 'Xero refused the connection.',
        )
      }

      const code = req.searchParams?.get('code')
      if (!code) throw new XeroOAuthError('invalid_request', 'The callback is missing its code.')

      const state = await verifyOAuthState({
        secret: stateSecretOf(req, options),
        token: req.searchParams?.get('state'),
      })

      // The browser returning from Xero must be the one that started the flow.
      if (!sameSecret(cookieValue(req, XERO_OAUTH_COOKIE), state.nonce)) {
        throw new XeroOAuthError('invalid_state', 'This connect link is invalid or has expired.')
      }

      if (options.scope === 'tenant' && state.tenant === null) {
        throw new XeroOAuthError('invalid_state', 'This connect link is invalid or has expired.')
      }

      const user = await userFromState(req.payload, state)
      const settings = await settingsForUser({
        create: true,
        options,
        payload: req.payload,
        settingsID: state.settings,
        tenantID: state.tenant,
        user,
      })

      // The row must be the one the connect step signed for, and for the same tenant: neither
      // the state nor the user's wider access may move the tokens elsewhere.
      if (
        String(settings.id) !== String(state.settings) ||
        (options.scope === 'tenant' &&
          String(idOf(settings[options.tenantField] as RelationRef)) !== String(state.tenant))
      ) {
        throw new XeroOAuthError('invalid_state', 'This connect link is invalid or has expired.')
      }

      // Reading the row is enough to find it; replacing its connection needs update rights.
      await assertCanUpdateSettings({
        collection: options.settingsSlug,
        payload: req.payload,
        settings,
        user,
      })

      const tokens = await exchangeCodeForTokens(options.oauth, { code })
      const xeroTenantId = xeroOrganisationId(
        await fetchXeroConnections(options.oauth, { accessToken: tokens.accessToken }),
      )

      await saveXeroTokens({
        collection: options.settingsSlug,
        data: { connectedAt: new Date().toISOString(), xeroTenantId },
        encryptionKey: options.oauth.encryptionKey,
        payload: req.payload,
        settings,
        // Xero only returns a refresh token because `offline_access` was requested; without
        // one the connection would expire within the hour, so treat that as a failure.
        tokens: refreshTokenRequired(tokens),
      })

      const response = redirectResponse(settingsAdminURL(req, settings, options.settingsSlug))
      response.headers.append('set-cookie', clearedNonceCookie())

      return response
    } catch (error) {
      if (error instanceof XeroOAuthError) return errorResponse(error)

      req.payload.logger.error({ err: error, msg: 'xero: callback failed' })

      return errorResponse(new XeroOAuthError('invalid_response', 'Could not finish the Xero connection.'))
    }
  }

/**
 * POST /api/xero/refresh?tenant=<id or slug> → `{ refreshed, expiresAt }`.
 *
 * Xero tokens are refreshed automatically whenever invoicing uses one (see
 * `getXeroAccessToken`); this endpoint lets an admin check, and repair, the connection from
 * the panel. It never returns the access token itself: there is no reason for a browser to
 * hold one.
 */
export const xeroRefreshHandler =
  (incoming: XeroOAuthEndpointOptions = {}) =>
  async (req: PayloadRequest): Promise<Response> => {
    const options = resolveOptions(incoming)

    try {
      const user = requireUser(req)
      const tenantID = await resolveTenantID({ options, payload: req.payload, req })
      const settings = await settingsForUser({
        create: false,
        options,
        payload: req.payload,
        tenantID,
        user,
      })

      const withTokens = await findSettingsWithTokens({
        collection: options.settingsSlug,
        id: settings.id,
        payload: req.payload,
      })

      if (!withTokens) throw new XeroOAuthError('settings_not_found', 'These Xero settings no longer exist.')

      await assertCanUpdateSettings({
        collection: options.settingsSlug,
        payload: req.payload,
        settings,
        user,
      })

      const { expiresAt, refreshed } = await getXeroAccessToken({
        collection: options.settingsSlug,
        oauth: options.oauth,
        payload: req.payload,
        settings: withTokens,
      })

      return noStore(Response.json({ expiresAt, refreshed }))
    } catch (error) {
      if (error instanceof XeroOAuthError) return errorResponse(error)

      req.payload.logger.error({ err: error, msg: 'xero: refresh failed' })

      return errorResponse(new XeroOAuthError('refresh_failed', 'Could not refresh the Xero connection.'))
    }
  }

/** The endpoints, for the plugin to add to the Payload config. */
export const xeroOAuthEndpoints = (options: XeroOAuthEndpointOptions = {}): Endpoint[] => {
  const resolved = resolveOptions(options)

  return [
    { handler: xeroConnectHandler(options), method: 'get', path: resolved.connectPath },
    { handler: xeroCallbackHandler(options), method: 'get', path: resolved.callbackPath },
    { handler: xeroRefreshHandler(options), method: 'post', path: resolved.refreshPath },
  ]
}
