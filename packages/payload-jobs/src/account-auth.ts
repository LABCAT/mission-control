import {
  logoutOperation,
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionSlug,
  type Endpoint,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { getTenantRole, type MissionControlUser, type TenantRole } from './access'
import { createTenantEmailSender, type TenantEmailSender } from './email'
import { createMemoryRateLimiter, type RateLimiter } from './rate-limit'
import { resolveSiteKey } from './site-keys'

/**
 * Front-end account auth (PJ-81). The Astro sites call these endpoints server-side with their
 * site key (`x-site-key`, PJ-07). The site keeps the returned token in an httpOnly cookie on
 * its own domain; see docs/ACCOUNT-AUTH.md for the cookie contract.
 *
 * Everything is scoped to one tenant: `/api/tenants/:slug/account/*`. The tenant in the path
 * must be the tenant the site key belongs to, and a user can only sign in on a tenant they are
 * a member of. Login goes through Payload's own login operation, so `beforeLogin` hooks (the
 * WordPress legacy hash login, PJ-34) and lockout apply as they do everywhere else.
 *
 * PJ-29 (employer sign-up) reuses `resolveAccountTenant`, `registerAccountUser`,
 * `enforceRateLimit` and `accountResponse` rather than copying them.
 */

/**
 * Path under the tenants collection. Payload routes `/api/tenants/*` to the collection's own
 * endpoints, so these are collection endpoints and the full URL is
 * `/api/tenants/:slug/account/<action>`. PJ-29 adds `/:slug/employer-signup` the same way.
 */
export const ACCOUNT_AUTH_BASE_PATH = '/:slug/account'

/** Context flag set while creating a site account, so the first-user bootstrap hook skips it. */
export const ACCOUNT_SIGNUP_CONTEXT = 'missionControlAccountSignup'

/** Header an authenticated site uses to pass the real visitor IP for rate limiting. */
export const END_USER_IP_HEADER = 'x-end-user-ip'

export const PASSWORD_MIN_LENGTH = 8
// Payload hashes with PBKDF2; cap the input so a huge body cannot be used to burn CPU.
export const PASSWORD_MAX_LENGTH = 128

/**
 * Users collection hooks that make `auth.verify` apply to site sign-ups only.
 *
 * - Payload never sends its own verification email. Site sign-ups send a tenant-branded one
 *   from `registerAccountUser`, and the default email would link to the admin panel.
 * - Users created any other way (the admin, scripts, imports) are verified on creation, as
 *   they were before verification was switched on.
 */
export const accountUserHooks: {
  beforeChange: CollectionBeforeChangeHook
  beforeOperation: CollectionBeforeOperationHook
} = {
  beforeChange: ({ data, operation, req }) => {
    if (operation === 'create' && !req.context?.[ACCOUNT_SIGNUP_CONTEXT]) {
      data._verified = true
    }

    return data
  },
  beforeOperation: ({ args, operation }) =>
    operation === 'create' ? { ...args, disableVerificationEmail: true } : args,
}

export type AccountTenant = TenantEmailSender & {
  domains?: null | { domain?: null | string }[]
  id: number | string
  name?: null | string
  slug: string
}

export type AccountAuthOptions = {
  /** Tenant roles that may sign in on a site. Other members use the admin. */
  accountRoles?: readonly TenantRole[]
  /**
   * Rate limiter, or a function returning one per request. Pass the Cloudflare Rate Limiting
   * binding in production (it matches this shape). Defaults to an in-memory limiter per isolate.
   */
  rateLimiter?: ((req: PayloadRequest) => RateLimiter | undefined) | RateLimiter
  /** Path on the tenant site that receives the reset link. */
  resetPasswordPath?: string
  tenantsSlug?: string
  usersSlug?: string
  /** Path on the tenant site that receives the verification link. */
  verifyEmailPath?: string
}

type ResolvedOptions = Required<Omit<AccountAuthOptions, 'rateLimiter'>> & {
  rateLimiter: AccountAuthOptions['rateLimiter']
}

type ApiError = { code: string; message: string; status: number }

const ERRORS = {
  invalidBody: { code: 'invalid_request', message: 'The request body is not valid.', status: 400 },
  invalidCredentials: {
    code: 'invalid_credentials',
    message: 'The email or password is incorrect.',
    status: 401,
  },
  invalidSiteKey: {
    code: 'invalid_site_key',
    message: 'A valid site key is required.',
    status: 401,
  },
  invalidToken: {
    code: 'invalid_token',
    message: 'This link is invalid or has expired.',
    status: 400,
  },
  notAuthenticated: { code: 'not_authenticated', message: 'Not signed in.', status: 401 },
  tenantMismatch: {
    code: 'tenant_mismatch',
    message: 'This site key does not belong to this tenant.',
    status: 403,
  },
  tenantNotConfigured: {
    code: 'tenant_not_configured',
    message: 'This tenant has no site domain to build links with.',
    status: 500,
  },
  tenantNotFound: { code: 'tenant_not_found', message: 'Unknown tenant.', status: 404 },
  tooManyRequests: {
    code: 'too_many_requests',
    message: 'Too many attempts. Try again in a minute.',
    status: 429,
  },
  unverified: {
    code: 'email_not_verified',
    message: 'Verify your email address before signing in.',
    status: 403,
  },
  weakPassword: {
    code: 'invalid_password',
    message: `Use a password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
    status: 400,
  },
} satisfies Record<string, ApiError>

/** A thrown API error, turned into a JSON response by the endpoint wrapper. */
export class AccountAuthError extends Error {
  readonly code: string
  readonly headers?: Record<string, string>
  readonly status: number

  constructor({ code, message, status }: ApiError, headers?: Record<string, string>) {
    super(message)
    this.name = 'AccountAuthError'
    this.code = code
    this.headers = headers
    this.status = status
  }
}

export const accountResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  Response.json(body, {
    headers: { 'cache-control': 'no-store', ...headers },
    status,
  })

const errorResponse = (error: AccountAuthError): Response =>
  accountResponse(
    { error: { code: error.code, message: error.message } },
    error.status,
    error.headers,
  )

const DEFAULTS: ResolvedOptions = {
  accountRoles: ['seeker', 'employer'],
  rateLimiter: undefined,
  resetPasswordPath: '/account/reset-password',
  tenantsSlug: 'tenants',
  usersSlug: 'users',
  verifyEmailPath: '/account/verify-email',
}

const resolveOptions = (options: AccountAuthOptions = {}): ResolvedOptions => ({
  ...DEFAULTS,
  ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
})

type RawUser = MissionControlUser & {
  _verificationToken?: null | string
  email: string
  firstName?: null | string
  id: number | string
  lastName?: null | string
}

const normaliseEmail = (value: unknown): null | string => {
  if (typeof value !== 'string') return null

  const email = value.trim().toLowerCase()

  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

const readBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  try {
    const body: unknown = await req.json?.()

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>
    }
  } catch {
    // fall through to the error below
  }

  throw new AccountAuthError(ERRORS.invalidBody)
}

const readPassword = (body: Record<string, unknown>): string => {
  const { password } = body

  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new AccountAuthError(ERRORS.weakPassword)
  }

  return password
}

const readOptionalName = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : undefined

/**
 * Resolve the tenant for an account request. The site key must be present and valid, and it
 * must belong to the tenant named in the path. An aggregate key does not sign users in on
 * other tenants: accounts are always per tenant.
 */
export const resolveAccountTenant = async (
  req: PayloadRequest,
  options: Pick<ResolvedOptions, 'tenantsSlug'>,
): Promise<AccountTenant> => {
  const siteKey = await resolveSiteKey(req)
  if (!siteKey) throw new AccountAuthError(ERRORS.invalidSiteKey)

  const slug = req.routeParams?.slug
  if (typeof slug !== 'string' || !slug) throw new AccountAuthError(ERRORS.tenantNotFound)

  const result = await req.payload.find({
    collection: options.tenantsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { slug: { equals: slug } },
  })

  const tenant = result.docs[0] as unknown as AccountTenant | undefined
  if (!tenant) throw new AccountAuthError(ERRORS.tenantNotFound)

  if (String(tenant.id) !== String(siteKey.tenantID)) {
    throw new AccountAuthError(ERRORS.tenantMismatch)
  }

  return tenant
}

const memoryLimiter = createMemoryRateLimiter({ limit: 10, windowMs: 60_000 })

const limiterFor = (
  req: PayloadRequest,
  options: Pick<ResolvedOptions, 'rateLimiter'>,
): RateLimiter => {
  const configured =
    typeof options.rateLimiter === 'function' ? options.rateLimiter(req) : options.rateLimiter

  return configured ?? memoryLimiter
}

const clientIP = (req: PayloadRequest): string =>
  req.headers.get(END_USER_IP_HEADER)?.trim() ||
  req.headers.get('cf-connecting-ip')?.trim() ||
  'unknown'

/**
 * Rate limit an action per tenant and visitor IP, and per identifier (usually the email) so
 * rotating IPs does not get around the limit. Throws a 429 when any key is over its limit.
 */
export const enforceRateLimit = async ({
  action,
  identifier,
  options,
  req,
  tenant,
}: {
  action: string
  identifier?: null | string
  options: Pick<ResolvedOptions, 'rateLimiter'>
  req: PayloadRequest
  tenant: Pick<AccountTenant, 'id'>
}): Promise<void> => {
  const limiter = limiterFor(req, options)
  const prefix = `${action}:${tenant.id}`
  const keys = [`${prefix}:ip:${clientIP(req)}`]

  if (identifier) keys.push(`${prefix}:id:${identifier}`)

  for (const key of keys) {
    const { success } = await limiter.limit({ key })

    if (!success) throw new AccountAuthError(ERRORS.tooManyRequests, { 'retry-after': '60' })
  }
}

const canSignInOn = (
  user: MissionControlUser | null | undefined,
  tenantID: number | string,
  options: Pick<ResolvedOptions, 'accountRoles'>,
): boolean => {
  const role = getTenantRole(user, tenantID)

  return role !== null && options.accountRoles.includes(role)
}

const findUserByEmail = async (
  payload: Payload,
  options: Pick<ResolvedOptions, 'usersSlug'>,
  email: string,
): Promise<RawUser | null> =>
  (await payload.db.findOne({
    collection: options.usersSlug as CollectionSlug,
    where: { email: { equals: email } },
  })) as unknown as RawUser | null

const publicUser = (user: RawUser, tenantID: number | string) => ({
  id: user.id,
  email: user.email,
  firstName: user.firstName ?? null,
  lastName: user.lastName ?? null,
  role: getTenantRole(user, tenantID),
})

/** The site URL for links in emails. Uses the tenant's first domain, never request input. */
export const tenantSiteURL = (tenant: AccountTenant): null | string => {
  const raw = tenant.domains?.find((row) => row?.domain)?.domain?.trim()
  if (!raw) return null

  const host = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)

  return `${local ? 'http' : 'https'}://${host}`
}

const escapeHTML = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

// TODO(PJ-50): replace these inline emails with the tenant email templates (PJ-27) once the
// template renderer lands, so tenants can edit the text and the layout carries their branding.
const linkEmail = ({
  intro,
  label,
  tenant,
  url,
}: {
  intro: string
  label: string
  tenant: AccountTenant
  url: string
}): string => {
  const name = escapeHTML(tenant.name ?? tenant.slug)
  const href = escapeHTML(url)

  return (
    `<p>${escapeHTML(intro)}</p>` +
    `<p><a href="${href}">${escapeHTML(label)}</a></p>` +
    `<p>If the link does not work, copy this address into your browser:<br>${href}</p>` +
    `<p>${name}</p>`
  )
}

const sendLinkEmail = async ({
  payload,
  subject,
  tenant,
  to,
  ...content
}: {
  intro: string
  label: string
  payload: Payload
  subject: string
  tenant: AccountTenant
  to: string
  url: string
}): Promise<void> => {
  try {
    await createTenantEmailSender(payload)({
      html: linkEmail({ ...content, tenant }),
      subject,
      tenant,
      to,
    })
  } catch (error) {
    // The caller answers the same way whether or not the email went out, so an address
    // cannot be probed. Log it so the failure is visible.
    payload.logger.error({ err: error, msg: `account-auth: could not send "${subject}"` })
  }
}

const sendVerificationEmail = (
  payload: Payload,
  options: ResolvedOptions,
  tenant: AccountTenant,
  user: Pick<RawUser, 'email'>,
  token: string,
): Promise<void> => {
  const base = tenantSiteURL(tenant)!
  const name = tenant.name ?? tenant.slug

  return sendLinkEmail({
    intro: `Confirm your email address to finish creating your ${name} account.`,
    label: 'Verify my email',
    payload,
    subject: `Verify your email for ${name}`,
    tenant,
    to: user.email,
    url: `${base}${options.verifyEmailPath}?token=${encodeURIComponent(token)}`,
  })
}

export type RegisterAccountUserArgs = {
  email: string
  firstName?: string
  lastName?: string
  options?: AccountAuthOptions
  password: string
  payload: Payload
  /** Tenant role for the new user: `seeker` here, `employer` for PJ-29. */
  role: TenantRole
  tenant: AccountTenant
}

/**
 * Create an unverified user who is a member of one tenant, and email the verification link
 * from the tenant's sender. Returns `null` without creating anything when the email is already
 * registered. An existing unverified member of this tenant gets the link again, which is how a
 * lost email is resent without a separate endpoint. PJ-29 calls this with `role: 'employer'`
 * and then creates the organisation.
 */
export const registerAccountUser = async ({
  email,
  firstName,
  lastName,
  options: incoming,
  password,
  payload,
  role,
  tenant,
}: RegisterAccountUserArgs): Promise<null | RawUser> => {
  const options = resolveOptions(incoming)

  if (!tenantSiteURL(tenant)) throw new AccountAuthError(ERRORS.tenantNotConfigured)

  const existing = await findUserByEmail(payload, options, email)

  if (existing) {
    const unverifiedMember =
      (existing as { _verified?: boolean })._verified === false &&
      getTenantRole(existing, tenant.id) === role

    if (unverifiedMember && existing._verificationToken) {
      await sendVerificationEmail(payload, options, tenant, existing, existing._verificationToken)
    }

    return null
  }

  const created = (await payload.create({
    collection: options.usersSlug as CollectionSlug,
    context: { [ACCOUNT_SIGNUP_CONTEXT]: true },
    data: {
      email,
      firstName,
      lastName,
      password,
      role: 'user',
      tenants: [{ role, tenant: tenant.id }],
    } as never,
    disableVerificationEmail: true,
    overrideAccess: true,
  })) as unknown as RawUser

  // The create result hides the token, so read it from the database.
  const stored = (await payload.db.findOne({
    collection: options.usersSlug as CollectionSlug,
    where: { id: { equals: created.id } },
  })) as unknown as RawUser | null

  if (stored?._verificationToken) {
    await sendVerificationEmail(payload, options, tenant, created, stored._verificationToken)
  }

  return created
}

const findByToken = async (
  payload: Payload,
  options: ResolvedOptions,
  field: '_verificationToken' | 'resetPasswordToken',
  token: unknown,
): Promise<RawUser | null> => {
  if (typeof token !== 'string' || !token || token.length > 200) return null

  return (await payload.db.findOne({
    collection: options.usersSlug as CollectionSlug,
    where: { [field]: { equals: token } },
  })) as unknown as RawUser | null
}

const statusOf = (error: unknown): number =>
  typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 500

/** Map a Payload login failure to the API error the site sees. */
const mapLoginError = (error: unknown): AccountAuthError => {
  const name = (error as { name?: string })?.name

  if (name === 'AuthenticationError') return new AccountAuthError(ERRORS.invalidCredentials)
  if (name === 'UnverifiedEmail') return new AccountAuthError(ERRORS.unverified)
  if (name === 'LockedAuth') {
    return new AccountAuthError(ERRORS.tooManyRequests, { 'retry-after': '600' })
  }

  // Anything a `beforeLogin` hook throws on purpose (a 4xx) is passed on as a generic failure.
  return statusOf(error) < 500
    ? new AccountAuthError(ERRORS.invalidCredentials)
    : (error as AccountAuthError)
}

type Handler = (args: {
  options: ResolvedOptions
  req: PayloadRequest
  tenant: AccountTenant
}) => Promise<Response>

const endpoint = (
  options: ResolvedOptions,
  method: Endpoint['method'],
  path: string,
  handler: Handler,
): Endpoint => ({
  handler: async (req) => {
    try {
      const tenant = await resolveAccountTenant(req, options)

      return await handler({ options, req, tenant })
    } catch (error) {
      if (error instanceof AccountAuthError) return errorResponse(error)

      req.payload.logger.error({ err: error, msg: `account-auth: ${path} failed` })

      return accountResponse(
        { error: { code: 'server_error', message: 'Something went wrong.' } },
        500,
      )
    }
  },
  method,
  path: `${ACCOUNT_AUTH_BASE_PATH}/${path}`,
})

const SUBMITTED_OK = { ok: true }

const login: Handler = async ({ options, req, tenant }) => {
  const body = await readBody(req)
  const email = normaliseEmail(body.email)
  const { password } = body

  if (!email || typeof password !== 'string' || !password || password.length > 1000) {
    throw new AccountAuthError(ERRORS.invalidCredentials)
  }

  await enforceRateLimit({ action: 'login', identifier: email, options, req, tenant })

  // A user from another tenant gets the same answer as a wrong password, and Payload's login
  // never runs for them, so their password is not even checked on this tenant.
  const existing = await findUserByEmail(req.payload, options, email)
  if (existing && !canSignInOn(existing, tenant.id, options)) {
    throw new AccountAuthError(ERRORS.invalidCredentials)
  }

  let result
  try {
    result = await req.payload.login({
      collection: options.usersSlug as CollectionSlug,
      data: { email, password },
      overrideAccess: true,
    })
  } catch (error) {
    throw mapLoginError(error)
  }

  const user = result.user as unknown as RawUser
  const token = result.token
  const exp = result.exp

  // Belt and braces: the pre-check above already covers this.
  if (!token || !canSignInOn(user, tenant.id, options)) {
    throw new AccountAuthError(ERRORS.invalidCredentials)
  }

  return accountResponse({
    exp,
    expiresIn: typeof exp === 'number' ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : null,
    token,
    user: publicUser(user, tenant.id),
  })
}

/**
 * The signed-in user, or null. Membership is re-read from the database here instead of trusting
 * `req.user` (Payload's JWT strategy loads it too, but authorisation must not depend on that),
 * so removing a membership or changing a role takes effect on the next request.
 */
const currentUser = async (
  req: PayloadRequest,
  tenant: AccountTenant,
  options: ResolvedOptions,
): Promise<RawUser | null> => {
  const session = req.user as (RawUser & { collection?: string }) | null

  if (!session || session.collection !== options.usersSlug) return null

  const fresh = (await req.payload.db.findOne({
    collection: options.usersSlug as CollectionSlug,
    where: { id: { equals: session.id } },
  })) as unknown as RawUser | null

  return fresh && canSignInOn(fresh, tenant.id, options) ? fresh : null
}

/**
 * The signed-in user of an account request, read fresh, or null when the token is missing,
 * expired or not a member of `tenant` in an account role. Checkout (PJ-31) uses it.
 */
export const resolveAccountUser = (
  req: PayloadRequest,
  tenant: AccountTenant,
  options: AccountAuthOptions = {},
): Promise<RawUser | null> => currentUser(req, tenant, resolveOptions(options))

const me: Handler = async ({ options, req, tenant }) => {
  const user = await currentUser(req, tenant, options)
  if (!user) throw new AccountAuthError(ERRORS.notAuthenticated)

  return accountResponse({ user: publicUser(user, tenant.id) })
}

const logout: Handler = async ({ options, req, tenant }) => {
  // Logging out is idempotent: a missing or expired token still answers 200, so the site can
  // always clear its cookie.
  if (await currentUser(req, tenant, options)) {
    await logoutOperation({
      collection: req.payload.collections[options.usersSlug as CollectionSlug],
      req,
    })
  }

  return accountResponse(SUBMITTED_OK)
}

const forgotPassword: Handler = async ({ options, req, tenant }) => {
  const body = await readBody(req)
  const email = normaliseEmail(body.email)

  // The answer never depends on whether the account exists.
  if (!email) return accountResponse(SUBMITTED_OK)

  await enforceRateLimit({ action: 'forgot-password', identifier: email, options, req, tenant })

  const user = await findUserByEmail(req.payload, options, email)
  if (!user || !canSignInOn(user, tenant.id, options)) return accountResponse(SUBMITTED_OK)

  const base = tenantSiteURL(tenant)
  if (!base) {
    req.payload.logger.error(`account-auth: tenant ${tenant.slug} has no domain for reset links`)

    return accountResponse(SUBMITTED_OK)
  }

  const token = await req.payload.forgotPassword({
    collection: options.usersSlug as CollectionSlug,
    data: { email },
    disableEmail: true,
    overrideAccess: true,
  })

  if (token) {
    const name = tenant.name ?? tenant.slug

    await sendLinkEmail({
      intro: `Use this link to choose a new password for your ${name} account. It expires in an hour.`,
      label: 'Reset my password',
      payload: req.payload,
      subject: `Reset your ${name} password`,
      tenant,
      to: email,
      url: `${base}${options.resetPasswordPath}?token=${encodeURIComponent(token)}`,
    })
  }

  return accountResponse(SUBMITTED_OK)
}

const resetPassword: Handler = async ({ options, req, tenant }) => {
  const body = await readBody(req)
  const password = readPassword(body)

  await enforceRateLimit({ action: 'reset-password', options, req, tenant })

  const owner = await findByToken(req.payload, options, 'resetPasswordToken', body.token)

  if (!owner || !canSignInOn(owner, tenant.id, options)) {
    throw new AccountAuthError(ERRORS.invalidToken)
  }

  try {
    // Payload expires the token as it uses it, so a second attempt finds nothing.
    await req.payload.resetPassword({
      collection: options.usersSlug as CollectionSlug,
      data: { password, token: body.token as string },
      overrideAccess: true,
    })
  } catch (error) {
    if (statusOf(error) < 500) throw new AccountAuthError(ERRORS.invalidToken)
    throw error
  }

  return accountResponse(SUBMITTED_OK)
}

const register: Handler = async ({ options, req, tenant }) => {
  const body = await readBody(req)
  const email = normaliseEmail(body.email)

  if (!email) throw new AccountAuthError(ERRORS.invalidBody)

  const password = readPassword(body)

  await enforceRateLimit({ action: 'register', identifier: email, options, req, tenant })

  await registerAccountUser({
    email,
    firstName: readOptionalName(body.firstName),
    lastName: readOptionalName(body.lastName),
    options,
    password,
    payload: req.payload,
    role: 'seeker',
    tenant,
  })

  // The same answer whether the address is new or already registered.
  return accountResponse(SUBMITTED_OK, 202)
}

const verifyEmail: Handler = async ({ options, req, tenant }) => {
  const body = await readBody(req)

  await enforceRateLimit({ action: 'verify-email', options, req, tenant })

  const owner = await findByToken(req.payload, options, '_verificationToken', body.token)

  if (!owner || !canSignInOn(owner, tenant.id, options)) {
    throw new AccountAuthError(ERRORS.invalidToken)
  }

  try {
    // Payload clears the token as it verifies, so it works once.
    await req.payload.verifyEmail({
      collection: options.usersSlug as CollectionSlug,
      token: body.token as string,
    })
  } catch (error) {
    if (statusOf(error) < 500) throw new AccountAuthError(ERRORS.invalidToken)
    throw error
  }

  return accountResponse(SUBMITTED_OK)
}

/** The account auth endpoints, to add to the tenants collection's `endpoints`. */
export const accountAuthEndpoints = (incoming: AccountAuthOptions = {}): Endpoint[] => {
  const options = resolveOptions(incoming)

  return [
    endpoint(options, 'post', 'login', login),
    endpoint(options, 'post', 'logout', logout),
    endpoint(options, 'get', 'me', me),
    endpoint(options, 'post', 'forgot-password', forgotPassword),
    endpoint(options, 'post', 'reset-password', resetPassword),
    endpoint(options, 'post', 'register', register),
    endpoint(options, 'post', 'verify-email', verifyEmail),
  ]
}
