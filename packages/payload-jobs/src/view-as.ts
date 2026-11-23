import {
  Forbidden,
  logoutOperation,
  type AuthStrategy,
  type CollectionAfterChangeHook,
  type CollectionAfterDeleteHook,
  type CollectionAfterLogoutHook,
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  type CollectionSlug,
  type Config,
  type Endpoint,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { addSessionToUser } from 'payload/shared'

import { getTenantRole, isSuperAdmin, type MissionControlUser, type TenantRole } from './access'
import { VIEW_AS_BUTTON_COMPONENT_PATH } from './admin'
import { AUDIT_LOG_SLUG, auditLogCollection, hasAuditLog, writeAuditLog } from './audit-log'

/**
 * "View as user" (PJ-119, S-073). A super admin can see the site exactly as one of its account
 * holders (a seeker or an employer) to help with support, replacing the legacy User Switching
 * plugin.
 *
 * How it works
 * ------------
 * 1. In the admin user screen the super admin clicks "View as this user" and picks a tenant.
 *    `POST /api/users/:id/view-as` creates a 30-minute session on the target user and returns a
 *    one-time `code` (valid 60 seconds), never the token itself. The admin page then posts the
 *    code to the tenant site.
 * 2. The site calls `POST /api/tenants/:slug/account/view-as/redeem` with its site key and the
 *    code, gets the view-as token, and stores it in its own `mc_session` cookie (30 minutes)
 *    plus a non-HttpOnly `impersonating=1` hint cookie that drives the banner.
 * 3. The token is not a Payload JWT. It is only accepted by `viewAsAuthStrategy` below, as a
 *    `Bearer` header (never a cookie), so Payload's normal strategy rejects it and every request
 *    made with it carries a `_viewAs` marker the guard rails and the audit log can see.
 * 4. Exit (`POST .../account/view-as/exit`, or the ordinary `logout`) revokes the session. The
 *    super admin's own admin session was never touched, so "restore" is just the browser
 *    returning to the admin.
 *
 * Guard rails (all enforced here, on the server)
 * ----------------------------------------------
 * - Start: a real, non-impersonated super admin session, same-origin JSON request with the
 *   CSRF header; the target must be a site account on that tenant (seeker/employer only), never
 *   a super admin, never themselves, never a user who is also staff anywhere.
 * - The token is bound to one tenant, expires after 30 minutes with no refresh, and is checked
 *   on every request against the live database: the session must still exist, the super admin
 *   must still be a super admin, and the target must still be eligible.
 * - While viewing: no change to email, password, role, memberships or any sign-in field, no
 *   account deletion, no token refresh or password reset, no purchase (orders), no admin panel.
 *   Blocked attempts are logged.
 * - Everything is written to the audit log with the super admin's id: start, redeem, exit, every
 *   blocked attempt and every document written or deleted during the session.
 */

/** Hard lifetime of a view-as session. There is no refresh. */
export const VIEW_AS_TTL_SECONDS = 30 * 60

/** How long the one-time code is valid. */
export const VIEW_AS_CODE_TTL_SECONDS = 60

/** Name of the auth strategy, also stored on `req.user._strategy`. */
export const VIEW_AS_STRATEGY = 'mc-view-as'

/** Header the admin UI sends on start. A cross-site form or fetch cannot set it without a CORS preflight. */
export const VIEW_AS_CSRF_HEADER = 'x-mc-view-as'

/**
 * Set on `req.context` by `exitViewAs` only, to let its own `logoutOperation` call through the
 * `afterLogout` guard. Never set by anything reachable from a request.
 */
export const VIEW_AS_EXIT_CONTEXT = 'viewAsExit'

export const VIEW_AS_CSRF_VALUE = 'start'

/** Path on the tenant site that receives the one-time code. */
export const VIEW_AS_SITE_START_PATH = '/account/view-as/start'

const TOKEN_PREFIX = 'mcva1'
const CODE_KEY_PREFIX = 'mc:view-as:code:'

/** Tenant roles that sign in on the site. These are the only users anyone can view as. */
export const VIEW_AS_ACCOUNT_ROLES: readonly TenantRole[] = ['seeker', 'employer']

/** Fields a view-as session may change on the user it is viewing. Nothing else. */
export const VIEW_AS_EDITABLE_USER_FIELDS: readonly string[] = ['firstName', 'lastName']

/** Operations on the users collection that a view-as session may never run. */
const BLOCKED_USER_OPERATIONS = new Set([
  'create',
  'delete',
  'forgotPassword',
  'login',
  'refresh',
  'resetPassword',
  'unlock',
  'verifyEmail',
])

export type ViewAsMarker = {
  /** The super admin's user id. */
  by: number | string
  expiresAt: number
  sid: string
  tenant: number | string
}

type Claims = {
  adm: number | string
  exp: number
  sid: string
  sub: number | string
  tid: number | string
}

/** The view-as marker on a user, or null. Set only by `viewAsAuthStrategy`. */
export const getViewAs = (user: unknown): null | ViewAsMarker => {
  const marker = (user as { _viewAs?: ViewAsMarker } | null | undefined)?._viewAs

  return marker && typeof marker === 'object' ? marker : null
}

export const isViewingAs = (req: { user?: unknown }): boolean => getViewAs(req.user) !== null

// ---------------------------------------------------------------------------------------------
// Token: `mcva1.<base64url claims>.<base64url HMAC-SHA256>`
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder()

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)

  return bytes
}

// A key derived for this one purpose, so a view-as signature is useless anywhere else.
const signingKey = (secret: string, usage: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    encoder.encode(`mission-control:view-as:v1:${secret}`),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    usage,
  )

export const signViewAsToken = async (secret: string, claims: Claims): Promise<string> => {
  const body = `${TOKEN_PREFIX}.${toBase64Url(encoder.encode(JSON.stringify(claims)))}`
  const signature = await crypto.subtle.sign('HMAC', await signingKey(secret, ['sign']), encoder.encode(body))

  return `${body}.${toBase64Url(new Uint8Array(signature))}`
}

/** The claims of a token with a valid signature that has not expired, else null. */
export const verifyViewAsToken = async (
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Claims | null> => {
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret, ['verify']),
      fromBase64Url(parts[2]!),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    )
    if (!valid) return null

    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]!))) as Partial<Claims>

    if (
      typeof claims.sid !== 'string' ||
      typeof claims.exp !== 'number' ||
      claims.exp <= nowSeconds ||
      (typeof claims.sub !== 'number' && typeof claims.sub !== 'string') ||
      (typeof claims.adm !== 'number' && typeof claims.adm !== 'string') ||
      (typeof claims.tid !== 'number' && typeof claims.tid !== 'string')
    ) {
      return null
    }

    return claims as Claims
  } catch {
    return null
  }
}

const sha256Hex = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

const randomCode = (): string => toBase64Url(crypto.getRandomValues(new Uint8Array(32)))

// ---------------------------------------------------------------------------------------------
// Who can be viewed
// ---------------------------------------------------------------------------------------------

type TargetUser = MissionControlUser & {
  id: number | string
  sessions?: { expiresAt?: Date | string; id: string }[] | null
}

export type IneligibleReason =
  | 'not_found'
  | 'not_site_account'
  | 'staff_account'
  | 'super_admin'

/**
 * Why a user cannot be viewed, or null when they can. Only a plain site account on this tenant
 * qualifies: a seeker or employer whose every membership is a site role. Anyone who is staff
 * anywhere (tenant admin, editor) or a super admin is refused, so a view-as session can never
 * hold more rights than a normal site sign-in.
 */
export const viewAsIneligibleReason = (
  target: null | TargetUser | undefined,
  tenantID: number | string,
  accountRoles: readonly TenantRole[] = VIEW_AS_ACCOUNT_ROLES,
): IneligibleReason | null => {
  if (!target) return 'not_found'
  if (isSuperAdmin(target) || target.role !== 'user') return 'super_admin'

  const role = getTenantRole(target, tenantID)
  if (role === null || !accountRoles.includes(role)) return 'not_site_account'

  const staff = (target.tenants ?? []).some(
    (membership) => membership?.role != null && !accountRoles.includes(membership.role),
  )

  return staff ? 'staff_account' : null
}

// ---------------------------------------------------------------------------------------------
// Auth strategy
// ---------------------------------------------------------------------------------------------

const readBearer = (headers: Headers): null | string => {
  const header = headers.get('authorization')
  if (!header) return null

  const [scheme, value, ...rest] = header.trim().split(/\s+/)

  return rest.length === 0 && scheme?.toLowerCase() === 'bearer' && value ? value : null
}

/**
 * Authenticates a view-as token, and only that. The user it returns is the target, with a
 * `_viewAs` marker. Everything is re-checked against the database on every request, so a
 * revoked session, a demoted super admin or a target who became staff stops working at once.
 */
export const viewAsAuthStrategy = ({
  accountRoles = VIEW_AS_ACCOUNT_ROLES,
  usersSlug = 'users',
}: {
  accountRoles?: readonly TenantRole[]
  usersSlug?: string
} = {}): AuthStrategy => ({
  name: VIEW_AS_STRATEGY,
  authenticate: async ({ headers, payload }) => {
    const token = readBearer(headers)
    if (!token || !token.startsWith(`${TOKEN_PREFIX}.`)) return { user: null }

    const claims = await verifyViewAsToken(payload.secret, token)
    if (!claims) return { user: null }

    const [target, admin] = await Promise.all([
      payload.findByID({
        collection: usersSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: claims.sub,
        overrideAccess: true,
      }) as Promise<null | TargetUser>,
      payload.findByID({
        collection: usersSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: claims.adm,
        overrideAccess: true,
      }) as Promise<null | TargetUser>,
    ])

    // The super admin must still be one, and still exist.
    if (!admin || !isSuperAdmin(admin)) return { user: null }

    // The target must still be a plain site account on the tenant the token is bound to.
    if (viewAsIneligibleReason(target, claims.tid, accountRoles) !== null || !target) {
      return { user: null }
    }

    // The session must still exist (exit, logout and a password reset revoke it) and be unexpired.
    const session = (target.sessions ?? []).find(({ id }) => id === claims.sid)
    if (!session || !session.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) {
      return { user: null }
    }

    const marker: ViewAsMarker = {
      by: claims.adm,
      expiresAt: claims.exp * 1000,
      sid: claims.sid,
      tenant: claims.tid,
    }

    return {
      user: {
        ...target,
        _sid: claims.sid,
        _strategy: VIEW_AS_STRATEGY,
        _viewAs: marker,
        collection: usersSlug,
      } as never,
    }
  },
})

// ---------------------------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------------------------

/** Log a blocked attempt. Written outside the request's transaction, so it survives the rollback. */
const logBlocked = async (req: PayloadRequest, what: string, detail: Record<string, unknown> = {}) => {
  const marker = getViewAs(req.user)
  if (!marker) return

  try {
    await writeAuditLog({
      entry: {
        action: 'view-as.blocked',
        actorID: marker.by,
        detail: { ...detail, blocked: what },
        sessionID: marker.sid,
        targetID: (req.user as { id: number | string }).id,
        tenantID: marker.tenant,
      },
      payload: req.payload,
    })
  } catch (error) {
    req.payload.logger.error({ err: error, msg: 'view-as: could not log a blocked action' })
  }
}

/**
 * Refuse an action while a super admin is viewing as a user, and log the attempt. Call it at the
 * top of any code that must never run in a view-as session (checkout, account deletion, changing
 * a sign-in). It does nothing for an ordinary request.
 */
export const assertNotViewingAs = async (
  req: PayloadRequest,
  what: string,
  detail?: Record<string, unknown>,
): Promise<void> => {
  if (!isViewingAs(req)) return

  await logBlocked(req, what, detail)

  throw new Forbidden(req.t)
}

// ---------------------------------------------------------------------------------------------
// Collection hooks
// ---------------------------------------------------------------------------------------------

const IGNORED_USER_KEYS = new Set(['createdAt', 'id', 'updatedAt'])

const usersBeforeDelete: CollectionBeforeDeleteHook = async ({ req }) => {
  await assertNotViewingAs(req, 'users.delete')
}

/**
 * Payload's own logout runs no `beforeOperation` hook, only `afterLogout`, so the users guards
 * never see it. It is refused for a view-as session: REST passes `allSessions` in the query
 * string and GraphQL passes it as a resolver argument the hook cannot read, so no shape of it can
 * be told apart from the destructive one, and `allSessions=true` empties the whole `sessions`
 * array and signs the real user out of every device. Ending a view is `account/view-as/exit` (or
 * the account `logout`), which calls `exitViewAs` and is logged as `view-as.exit`. This hook runs
 * before the write, so the sessions are untouched.
 */
const usersAfterLogout: CollectionAfterLogoutHook = async ({ req }) => {
  if (!getViewAs(req.user) || req.context?.[VIEW_AS_EXIT_CONTEXT] === true) return

  await logBlocked(req, 'users.logout', {
    ...(req.searchParams?.get('allSessions') === 'true' ? { allSessions: true } : {}),
    via: req.payloadAPI ?? 'local',
  })

  throw new Forbidden(req.t)
}

// A whitelist, not a blacklist: only the profile name may change. It runs in `beforeOperation`
// because only there is `args.data` what the caller sent; by `beforeValidate` and `beforeChange`
// Payload has merged the whole document into it, so every field would look changed. The email,
// password, role, memberships, organisation and every verification, reset and session field are
// refused. Creating a user is refused with the other blocked operations.
const usersBeforeOperation: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (!req || !isViewingAs(req)) return args

  if (BLOCKED_USER_OPERATIONS.has(operation)) await assertNotViewingAs(req, `users.${operation}`)

  if (operation === 'update') {
    const data = (args as { data?: Record<string, unknown> }).data ?? {}
    const forbidden = Object.keys(data).filter(
      (key) => !IGNORED_USER_KEYS.has(key) && !VIEW_AS_EDITABLE_USER_FIELDS.includes(key),
    )

    if (forbidden.length > 0) await assertNotViewingAs(req, 'users.update', { fields: forbidden })
  }

  return args
}

/** Orders cannot be created, changed or deleted in a view-as session: no purchases. */
const blockPurchases: CollectionBeforeChangeHook = async ({ data, req }) => {
  await assertNotViewingAs(req, 'orders.write')

  return data
}

const blockPurchaseDeletes: CollectionBeforeDeleteHook = async ({ req }) => {
  await assertNotViewingAs(req, 'orders.delete')
}

/** Record every document written during a view-as session, in the same transaction as the write. */
const logWrite: CollectionAfterChangeHook = async ({ collection, doc, operation, req }) => {
  const marker = getViewAs(req.user)
  if (!marker || collection.slug === AUDIT_LOG_SLUG) return doc

  await writeAuditLog({
    entry: {
      action: `view-as.${operation}`,
      actorID: marker.by,
      detail: { collection: collection.slug, id: (doc as { id?: unknown }).id ?? null },
      sessionID: marker.sid,
      targetID: (req.user as { id: number | string }).id,
      tenantID: marker.tenant,
    },
    payload: req.payload,
    req,
  })

  return doc
}

const logDelete: CollectionAfterDeleteHook = async ({ collection, doc, req }) => {
  const marker = getViewAs(req.user)
  if (!marker || collection.slug === AUDIT_LOG_SLUG) return doc

  await writeAuditLog({
    entry: {
      action: 'view-as.delete',
      actorID: marker.by,
      detail: { collection: collection.slug, id: (doc as { id?: unknown }).id ?? null },
      sessionID: marker.sid,
      targetID: (req.user as { id: number | string }).id,
      tenantID: marker.tenant,
    },
    payload: req.payload,
    req,
  })

  return doc
}

// ---------------------------------------------------------------------------------------------
// Start (admin, users collection)
// ---------------------------------------------------------------------------------------------

type StartOptions = {
  accountRoles: readonly TenantRole[]
  tenantsSlug: string
  usersSlug: string
}

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: { 'cache-control': 'no-store' }, status })

const fail = (status: number, code: string, message: string): Response =>
  json({ error: { code, message } }, status)

/** A same-origin, JSON, custom-header POST. A cross-site page can send none of these together. */
const looksLikeOurOwnAdminRequest = (req: PayloadRequest): boolean => {
  const origin = req.headers.get('origin')
  if (!origin) return false

  try {
    if (new URL(origin).origin !== new URL(req.url ?? '').origin) return false
  } catch {
    return false
  }

  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite && fetchSite !== 'same-origin') return false

  return (
    req.headers.get(VIEW_AS_CSRF_HEADER) === VIEW_AS_CSRF_VALUE &&
    (req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
  )
}

type TenantDoc = {
  domains?: null | { domain?: null | string }[]
  id: number | string
  slug: string
}

const findTenant = async (
  payload: Payload,
  tenantsSlug: string,
  value: unknown,
): Promise<null | TenantDoc> => {
  if (typeof value !== 'string' && typeof value !== 'number') return null

  const result = await payload.find({
    collection: tenantsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { or: [{ slug: { equals: String(value) } }, { id: { equals: value } }] },
  })

  return (result.docs[0] as unknown as TenantDoc | undefined) ?? null
}

/** The site's origin from the tenant's first domain. Never from request input. */
const siteOrigin = (tenant: TenantDoc): null | string => {
  const raw = tenant.domains?.find((row) => row?.domain)?.domain?.trim()
  if (!raw) return null

  const host = raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)

  return `${local ? 'http' : 'https'}://${host}`
}

const startEndpoint = (options: StartOptions): Endpoint => ({
  handler: async (req) => {
    try {
      const actor = req.user as (MissionControlUser & { id: number | string }) | null

      if (!actor) return fail(401, 'not_authenticated', 'Sign in to the admin first.')

      // Never start from a view-as session, and never on a token other than a real admin session.
      if (isViewingAs(req)) return fail(403, 'forbidden', 'Exit the current view first.')

      if (!looksLikeOurOwnAdminRequest(req)) {
        return fail(403, 'csrf', 'This request must come from the admin.')
      }

      // Read the role fresh: the session could be older than a demotion.
      const fresh = (await req.payload.findByID({
        collection: options.usersSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: actor.id,
        overrideAccess: true,
      })) as unknown as (MissionControlUser & { id: number | string }) | null

      if (!fresh || !isSuperAdmin(fresh)) {
        return fail(403, 'forbidden', 'Only super admins can view the site as a user.')
      }

      if (!hasAuditLog(req.payload)) {
        return fail(500, 'audit_unavailable', 'The audit log is not available, so this is refused.')
      }

      const targetID = req.routeParams?.id
      if (typeof targetID !== 'string' || !targetID) return fail(404, 'not_found', 'User not found.')

      if (String(targetID) === String(actor.id)) {
        return fail(403, 'forbidden', 'You cannot view the site as yourself.')
      }

      let body: Record<string, unknown> = {}
      try {
        const parsed: unknown = await req.json?.()
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        return fail(400, 'invalid_request', 'The request body is not valid.')
      }

      const tenant = await findTenant(req.payload, options.tenantsSlug, body.tenant)
      if (!tenant) return fail(404, 'tenant_not_found', 'Unknown tenant.')

      const target = (await req.payload.findByID({
        collection: options.usersSlug as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: targetID,
        overrideAccess: true,
      })) as unknown as null | TargetUser

      const reason = viewAsIneligibleReason(target, tenant.id, options.accountRoles)

      if (reason !== null || !target) {
        // Refused starts are logged too, whatever the reason, so probing is visible.
        await writeAuditLog({
          entry: {
            action: 'view-as.refused',
            actorID: actor.id,
            detail: { reason: reason ?? 'not_found' },
            targetID,
            tenantID: tenant.id,
          },
          payload: req.payload,
        })

        return reason === 'not_found' || reason === null
          ? fail(404, 'not_found', 'User not found.')
          : fail(
              403,
              'not_allowed',
              reason === 'not_site_account'
                ? 'This user has no site account on that tenant.'
                : 'You cannot view the site as this user.',
            )
      }

      const origin = siteOrigin(tenant)
      if (!origin) return fail(409, 'tenant_not_configured', 'This tenant has no site domain.')

      // The session is created on the target, in the same way as a normal sign-in, so a password
      // reset or sign-out of "all sessions" kills it too. It is cut to 30 minutes.
      const { sid } = await createViewAsSession({
        payload: req.payload,
        target,
        usersSlug: options.usersSlug,
      })

      if (!sid) return fail(500, 'session_unavailable', 'Sessions must be enabled for this.')

      const exp = Math.floor(Date.now() / 1000) + VIEW_AS_TTL_SECONDS
      const code = randomCode()

      // Logged before the code exists: if the log cannot be written, nothing can be redeemed.
      await writeAuditLog({
        entry: {
          action: 'view-as.start',
          actorID: actor.id,
          detail: { expiresAt: new Date(exp * 1000).toISOString(), tenant: tenant.slug },
          sessionID: sid,
          targetID: target.id,
          tenantID: tenant.id,
        },
        payload: req.payload,
      })

      await req.payload.kv.set(`${CODE_KEY_PREFIX}${await sha256Hex(code)}`, {
        actorID: actor.id,
        exp,
        codeExpiresAt: Date.now() + VIEW_AS_CODE_TTL_SECONDS * 1000,
        sid,
        targetID: target.id,
        tenantID: tenant.id,
      })

      return json({
        code,
        codeExpiresIn: VIEW_AS_CODE_TTL_SECONDS,
        expiresIn: VIEW_AS_TTL_SECONDS,
        startURL: `${origin}${VIEW_AS_SITE_START_PATH}`,
      })
    } catch (error) {
      req.payload.logger.error({ err: error, msg: 'view-as: start failed' })

      return fail(500, 'server_error', 'Something went wrong.')
    }
  },
  method: 'post',
  path: '/:id/view-as',
})

/** Add a 30-minute session to the user, like a sign-in does, without issuing a Payload token. */
const createViewAsSession = async ({
  payload,
  target,
  usersSlug,
}: {
  payload: Payload
  target: TargetUser
  usersSlug: string
}): Promise<{ sid: string | undefined }> => {
  const collectionConfig = payload.collections[usersSlug as CollectionSlug].config

  // The raw row, like a sign-in reads it, so the update below writes back exactly what is there.
  const raw = (await payload.db.findOne({
    collection: usersSlug as CollectionSlug,
    where: { id: { equals: target.id } },
  })) as unknown as TargetUser

  const { sid } = await addSessionToUser({
    collectionConfig,
    payload,
    req: { payload } as PayloadRequest,
    sessionExpiration: VIEW_AS_TTL_SECONDS,
    user: raw as never,
  })

  return { sid }
}

// ---------------------------------------------------------------------------------------------
// Redeem and exit (called by the site through the account endpoints)
// ---------------------------------------------------------------------------------------------

type CodeRecord = {
  actorID: number | string
  codeExpiresAt: number
  exp: number
  sid: string
  targetID: number | string
  tenantID: number | string
}

/**
 * Swap a one-time code for the view-as token. The code works once, for 60 seconds, and only on
 * the tenant it was issued for. Returns null for anything else, and never says which check failed.
 */
export const redeemViewAsCode = async ({
  accountRoles = VIEW_AS_ACCOUNT_ROLES,
  code,
  payload,
  tenantID,
  usersSlug,
}: {
  accountRoles?: readonly TenantRole[]
  code: unknown
  payload: Payload
  tenantID: number | string
  usersSlug: string
}): Promise<null | { expiresIn: number; token: string; user: TargetUser }> => {
  if (typeof code !== 'string' || code.length < 20 || code.length > 100) return null

  const key = `${CODE_KEY_PREFIX}${await sha256Hex(code)}`
  const record = await payload.kv.get<CodeRecord>(key)

  // Spent as soon as it is looked up, whatever happens next.
  await payload.kv.delete(key)

  if (!record || record.codeExpiresAt <= Date.now()) return null
  if (String(record.tenantID) !== String(tenantID)) return null

  const target = (await payload.findByID({
    collection: usersSlug as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: record.targetID,
    overrideAccess: true,
  })) as unknown as null | TargetUser

  const session = target?.sessions?.find(({ id }) => id === record.sid)
  if (!target || !session || viewAsIneligibleReason(target, tenantID, accountRoles) !== null) return null

  const token = await signViewAsToken(payload.secret, {
    adm: record.actorID,
    exp: record.exp,
    sid: record.sid,
    sub: record.targetID,
    tid: tenantID,
  })

  await writeAuditLog({
    entry: {
      action: 'view-as.redeem',
      actorID: record.actorID,
      sessionID: record.sid,
      targetID: record.targetID,
      tenantID,
    },
    payload,
  })

  return { expiresIn: Math.max(0, record.exp - Math.floor(Date.now() / 1000)), token, user: target }
}

/** End the view-as session of this request: revoke it and log the exit. Idempotent. */
export const exitViewAs = async ({
  req,
  usersSlug,
}: {
  req: PayloadRequest
  usersSlug: string
}): Promise<boolean> => {
  const marker = getViewAs(req.user)
  if (!marker) return false

  // This is the one logout that may run in a view: mark it so `usersAfterLogout` lets it through.
  const hadFlag = Object.prototype.hasOwnProperty.call(req.context ?? {}, VIEW_AS_EXIT_CONTEXT)
  const previous = req.context?.[VIEW_AS_EXIT_CONTEXT]
  req.context = { ...req.context, [VIEW_AS_EXIT_CONTEXT]: true }
  try {
    await logoutOperation({
      collection: req.payload.collections[usersSlug as CollectionSlug],
      req,
    })
  } finally {
    if (hadFlag) req.context[VIEW_AS_EXIT_CONTEXT] = previous
    else delete req.context[VIEW_AS_EXIT_CONTEXT]
  }

  await writeAuditLog({
    entry: {
      action: 'view-as.exit',
      actorID: marker.by,
      sessionID: marker.sid,
      targetID: (req.user as { id: number | string }).id,
      tenantID: marker.tenant,
    },
    payload: req.payload,
  })

  return true
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

export type ViewAsConfigOptions = {
  accountRoles?: readonly TenantRole[]
  /** Slug of the orders collection, which no view-as session may write. */
  ordersSlug?: null | string
  tenantsSlug?: string
  usersSlug?: string
}

const withUsersGuards = (collection: CollectionConfig, options: StartOptions): CollectionConfig => {
  const auth = typeof collection.auth === 'object' ? collection.auth : {}
  const adminAccess = collection.access?.admin

  return {
    ...collection,
    access: {
      ...collection.access,
      // Defence in depth: the token is bearer-only, so it cannot reach the admin UI anyway.
      admin: adminAccess
        ? (args) => (isViewingAs(args.req) ? false : adminAccess(args))
        : ({ req }) => !isViewingAs(req) && Boolean(req.user),
    },
    auth: {
      ...auth,
      strategies: [
        ...(auth.strategies ?? []),
        viewAsAuthStrategy({ accountRoles: options.accountRoles, usersSlug: options.usersSlug }),
      ],
    },
    admin: {
      ...collection.admin,
      components: {
        ...collection.admin?.components,
        edit: {
          ...collection.admin?.components?.edit,
          beforeDocumentControls: [
            ...(collection.admin?.components?.edit?.beforeDocumentControls ?? []),
            { path: VIEW_AS_BUTTON_COMPONENT_PATH },
          ],
        },
      },
    },
    endpoints: collection.endpoints === false ? false : [...(collection.endpoints ?? []), startEndpoint(options)],
    hooks: {
      ...collection.hooks,
      afterLogout: [usersAfterLogout, ...(collection.hooks?.afterLogout ?? [])],
      beforeDelete: [usersBeforeDelete, ...(collection.hooks?.beforeDelete ?? [])],
      beforeOperation: [usersBeforeOperation, ...(collection.hooks?.beforeOperation ?? [])],
    },
  }
}

/**
 * Turn on view-as for a config: the audit log collection, the auth strategy and guards on the
 * users collection, the purchase guard on orders, and the write log on every other collection.
 * Applied last, so it sees every collection the plugins added.
 */
export const withViewAs = (config: Config, incoming: ViewAsConfigOptions = {}): Config => {
  const options: StartOptions = {
    accountRoles: incoming.accountRoles ?? VIEW_AS_ACCOUNT_ROLES,
    tenantsSlug: incoming.tenantsSlug ?? 'tenants',
    usersSlug: incoming.usersSlug ?? 'users',
  }

  const collections = (config.collections ?? []).map((collection): CollectionConfig => {
    if (collection.slug === AUDIT_LOG_SLUG) return collection

    const logged: CollectionConfig = {
      ...collection,
      hooks: {
        ...collection.hooks,
        afterChange: [...(collection.hooks?.afterChange ?? []), logWrite],
        afterDelete: [...(collection.hooks?.afterDelete ?? []), logDelete],
      },
    }

    if (collection.slug === options.usersSlug) return withUsersGuards(logged, options)

    if (incoming.ordersSlug && collection.slug === incoming.ordersSlug) {
      return {
        ...logged,
        hooks: {
          ...logged.hooks,
          beforeChange: [blockPurchases, ...(logged.hooks?.beforeChange ?? [])],
          beforeDelete: [blockPurchaseDeletes, ...(logged.hooks?.beforeDelete ?? [])],
        },
      }
    }

    return logged
  })

  const hasAudit = collections.some((collection) => collection.slug === AUDIT_LOG_SLUG)

  return {
    ...config,
    collections: hasAudit ? collections : [...collections, auditLogCollection()],
  }
}
