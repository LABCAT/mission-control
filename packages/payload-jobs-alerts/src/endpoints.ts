import type { Endpoint, PayloadRequest } from 'payload'

import {
  AccountAuthError,
  accountResponse,
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  enforceRateLimit,
  getTenantRole,
  resolveAccountTenant,
  verifyTurnstileWithCloudflare,
  type MissionControlUser,
  type PayloadJobsCollectionSlugs,
  type RateLimiter,
  type TurnstileVerifier,
} from '@mission-control/payload-jobs'

import { createAlertTemplateSender, type AlertEmailSender } from './email'
import { normaliseSubscriberEmail } from './filters'
import { ALERT_MAIL_LIMIT, ALERT_MAIL_WINDOW_MS, createKvRateLimiter } from './kv-rate-limit'
import {
  assertAlertsEnabled,
  confirmAlert,
  DEFAULT_ALERT_PATHS,
  listAlerts,
  removeAlert,
  requestManageLink,
  subscribeToAlert,
  unsubscribeAlert,
  updateAlert,
  type AlertPaths,
  type AlertsContext,
  type AlertTenant,
} from './service'
import { ALERT_SUBSCRIPTIONS_SLUG } from './subscriptions'

/**
 * The alert endpoints (PJ-47), under the tenants collection like the account and form endpoints:
 * `POST /api/tenants/:slug/alerts/<action>`. The Astro site calls them server-side with its site
 * key, so the tenant is never taken from input and a key from one site cannot touch another.
 *
 * Only `subscribe` and `manage-link` send email, so only they carry the bot checks (honeypot,
 * Turnstile) and the two rate limits: one per visitor IP and address, and one per address alone
 * so rotating IPs cannot mail-bomb someone. The link endpoints (`confirm`, `manage`,
 * `unsubscribe`) are protected by their signature, not by a challenge: an unsubscribe must work
 * from a mail client's own one-click POST, which cannot solve one.
 */

export const ALERT_ENDPOINTS_BASE_PATH = '/:slug/alerts'

/** A hidden field a person never fills in. Any value means a bot, and nothing is stored. */
export const ALERT_HONEYPOT_FIELD = 'alert_website'

/** The field Turnstile's widget fills in. */
export const ALERT_TURNSTILE_FIELD = 'cf-turnstile-response'

export type AlertTurnstileOptions = {
  /** Set to `false` only where another layer already checks bots. Defaults to on. */
  enabled?: boolean
  /** Read per request so a Worker secret can be passed as a getter. Missing fails closed. */
  secret?: () => null | string | undefined
  verify?: TurnstileVerifier
}

type LimiterOption = ((req: PayloadRequest) => RateLimiter | undefined) | RateLimiter | undefined

export type AlertEndpointsOptions = {
  alertsSlug?: string
  /** Extra domains refused on top of the built-in list of disposable providers. */
  blockedEmailDomains?: readonly string[]
  /** Limits mail sent to one address (any IP). Defaults to 3 an hour, shared through the KV store. */
  emailRateLimiter?: LimiterOption
  paths?: AlertPaths
  /** Per visitor IP and address. Pass the Cloudflare Rate Limiting binding in production. */
  rateLimiter?: LimiterOption
  /** Defaults to PJ-50's `sendTemplate`; pass another sender to send mail some other way. */
  sendEmail?: AlertEmailSender
  slugs?: PayloadJobsCollectionSlugs
  tenantsSlug?: string
  turnstile?: AlertTurnstileOptions
}

const ERRORS = {
  emailNotConfigured: {
    code: 'email_not_configured',
    message: 'Email is not set up for this site yet.',
    status: 503,
  },
  invalidBody: { code: 'invalid_request', message: 'The request body is not valid.', status: 400 },
  tooManyEmails: {
    code: 'too_many_requests',
    message: 'Too many emails were sent to this address. Try again later.',
    status: 429,
  },
  turnstile: {
    code: 'turnstile_failed',
    message: 'The verification did not pass. Reload the page and try again.',
    status: 400,
  },
  turnstileNotConfigured: {
    code: 'turnstile_not_configured',
    message: 'The alert form is not configured.',
    status: 500,
  },
} as const

const defaultSender = createAlertTemplateSender()

/**
 * At most 3 alert emails an hour to one address, counted in the shared KV store so every Worker
 * agrees. The host can pass this as `emailRateLimiter`; it is also the default.
 */
export const alertMailRateLimiter = createKvRateLimiter({
  limit: ALERT_MAIL_LIMIT,
  windowMs: ALERT_MAIL_WINDOW_MS,
})

const limiterFor = (option: LimiterOption, req: PayloadRequest): RateLimiter | undefined =>
  typeof option === 'function' ? option(req) : option

const readBody = async (req: PayloadRequest): Promise<Record<string, unknown>> => {
  let raw: string
  try {
    raw = (await req.text?.()) ?? ''
  } catch {
    throw new AccountAuthError(ERRORS.invalidBody)
  }
  if (raw.trim() === '') return {}

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new AccountAuthError(ERRORS.invalidBody)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AccountAuthError(ERRORS.invalidBody)
  }

  return body as Record<string, unknown>
}

const remoteIP = (req: PayloadRequest): null | string =>
  req.headers.get('x-end-user-ip')?.trim() || req.headers.get('cf-connecting-ip')?.trim() || null

type Resolved = {
  context: AlertsContext
  options: ResolvedOptions
  req: PayloadRequest
  tenant: AlertTenant
}

type ResolvedOptions = Required<Pick<AlertEndpointsOptions, 'alertsSlug' | 'paths' | 'tenantsSlug'>> &
  Omit<AlertEndpointsOptions, 'alertsSlug' | 'paths' | 'tenantsSlug'>

/** The signed-in visitor, if the site passed their token and they belong to this site. */
const siteUser = (req: PayloadRequest, tenantID: number | string): null | { email: string } => {
  const user = req.user as (MissionControlUser & { email?: string }) | null | undefined
  if (!user?.email) return null
  if (!getTenantRole(user, tenantID)) return null

  return { email: user.email }
}

/** Throws unless the visitor is a person: honeypot empty, Turnstile passed. */
const checkNotABot = async (
  options: ResolvedOptions,
  req: PayloadRequest,
  body: Record<string, unknown>,
): Promise<'bot' | 'ok'> => {
  const honeypot = body[ALERT_HONEYPOT_FIELD]
  if (typeof honeypot === 'string' ? honeypot.trim() !== '' : honeypot != null && honeypot !== false) {
    return 'bot'
  }

  if (options.turnstile?.enabled === false) return 'ok'

  const secret = options.turnstile?.secret?.()?.trim()
  if (!secret) throw new AccountAuthError(ERRORS.turnstileNotConfigured)

  const raw = body.turnstileToken ?? body[ALERT_TURNSTILE_FIELD]
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (!token) throw new AccountAuthError(ERRORS.turnstile)

  const verify = options.turnstile?.verify ?? verifyTurnstileWithCloudflare
  const result = await verify({ remoteIp: remoteIP(req), secret, token })
  if (!result.success) throw new AccountAuthError(ERRORS.turnstile)

  return 'ok'
}

/** Two limits for an action that sends mail: this visitor, and this address from anywhere. */
const limitMail = async (
  options: ResolvedOptions,
  req: PayloadRequest,
  tenant: AlertTenant,
  action: string,
  emailInput: unknown,
): Promise<void> => {
  const email = normaliseSubscriberEmail(emailInput)

  await enforceRateLimit({
    action,
    identifier: email,
    options: { rateLimiter: options.rateLimiter },
    req,
    tenant,
  })

  if (!email) return
  const limiter = limiterFor(options.emailRateLimiter, req) ?? alertMailRateLimiter(req.payload)
  const { success } = await limiter.limit({ key: `alert-mail:${tenant.id}:${email}` })
  if (!success) throw new AccountAuthError(ERRORS.tooManyEmails, { 'retry-after': '3600' })
}

const handle =
  (
    options: ResolvedOptions,
    action: (resolved: Resolved, body: Record<string, unknown>) => Promise<Response>,
  ): NonNullable<Endpoint['handler']> =>
  async (req) => {
    try {
      const tenant = (await resolveAccountTenant(req, {
        tenantsSlug: options.tenantsSlug,
      })) as AlertTenant
      const body = await readBody(req)

      const context: AlertsContext = {
        alertsSlug: options.alertsSlug,
        blockedEmailDomains: options.blockedEmailDomains,
        paths: options.paths,
        payload: req.payload,
        secret: req.payload.secret,
        // PJ-50's sendTemplate unless the host brought its own sender.
        sendEmail: options.sendEmail ?? defaultSender,
        slugs: options.slugs,
        tenant,
        tenantScoped: true,
      }
      assertAlertsEnabled(context)

      return await action({ context, options, req, tenant }, body)
    } catch (error) {
      if (error instanceof AccountAuthError) {
        return accountResponse(
          { error: { code: error.code, message: error.message } },
          error.status,
          error.headers,
        )
      }
      req.payload.logger.error({ err: error, msg: 'alerts: request failed' })

      return accountResponse(
        { error: { code: 'server_error', message: 'Something went wrong.' } },
        500,
      )
    }
  }

export const alertEndpoints = (incoming: AlertEndpointsOptions = {}): Endpoint[] => {
  const options: ResolvedOptions = {
    ...incoming,
    alertsSlug: incoming.alertsSlug ?? ALERT_SUBSCRIPTIONS_SLUG,
    paths: incoming.paths ?? DEFAULT_ALERT_PATHS,
    slugs: incoming.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS,
    tenantsSlug: incoming.tenantsSlug ?? 'tenants',
  }
  const post = (path: string, handler: NonNullable<Endpoint['handler']>): Endpoint => ({
    handler,
    method: 'post',
    path: `${ALERT_ENDPOINTS_BASE_PATH}/${path}`,
  })

  return [
    post(
      'subscribe',
      handle(options, async ({ context, options: opts, req, tenant }, body) => {
        // A bot gets the answer a person gets, and nothing is stored or sent.
        if ((await checkNotABot(opts, req, body)) === 'bot') {
          return accountResponse({ ok: true, status: 'pending' }, 202)
        }
        const user = siteUser(req, tenant.id)
        await limitMail(opts, req, tenant, 'alert-subscribe', user?.email ?? body.email)

        const result = await subscribeToAlert(context, {
          email: body.email,
          filters: body.filters,
          frequency: body.frequency,
          user,
        })

        return accountResponse({ ok: true, ...result })
      }),
    ),
    post(
      'manage-link',
      handle(options, async ({ context, options: opts, req, tenant }, body) => {
        if ((await checkNotABot(opts, req, body)) === 'bot') return accountResponse({ ok: true }, 202)
        await limitMail(opts, req, tenant, 'alert-manage-link', body.email)

        await requestManageLink(context, body.email)

        return accountResponse({ ok: true })
      }),
    ),
    post(
      'confirm',
      handle(options, async ({ context }, body) =>
        accountResponse({ ok: true, ...(await confirmAlert(context, body.token)) }),
      ),
    ),
    post(
      'manage',
      handle(options, async ({ context }, body) =>
        accountResponse({ alerts: await listAlerts(context, body.token), ok: true }),
      ),
    ),
    post(
      'manage/update',
      handle(options, async ({ context }, body) =>
        accountResponse({
          alert: await updateAlert(context, body.token, body.id, {
            active: body.active,
            frequency: body.frequency,
          }),
          ok: true,
        }),
      ),
    ),
    post(
      'manage/remove',
      handle(options, async ({ context }, body) => {
        await removeAlert(context, body.token, body.id)

        return accountResponse({ ok: true })
      }),
    ),
    post(
      'unsubscribe',
      handle(options, async ({ context }, body) =>
        accountResponse({ ok: true, ...(await unsubscribeAlert(context, body.token)) }),
      ),
    ),
  ]
}

