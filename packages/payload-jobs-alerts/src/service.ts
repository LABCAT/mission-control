import type { CollectionSlug, Payload, TaskConfig, TaskSlug, Where } from 'payload'

import {
  AccountAuthError,
  DEFAULT_PAYLOAD_JOBS_SLUGS,
  isAddOnEnabled,
  tenantSiteURL,
  type AccountTenant,
  type PayloadJobsCollectionSlugs,
} from '@mission-control/payload-jobs'

import type { AlertEmailDoc, AlertEmailEvent, AlertEmailSender } from './email'
import {
  alertFilterKey,
  alertQueryString,
  isDisposableEmail,
  normaliseAlertFilterInput,
  normaliseSubscriberEmail,
  type AlertFilterValues,
} from './filters'
import { purgeStaleMailSlots } from './kv-rate-limit'
import { alertSettings } from './settings'
import { ALERT_FREQUENCIES, type AlertFrequency } from './subscriptions'
import { ALERT_TOKEN_TTL_MS, signAlertToken, verifyAlertToken, type AlertTokenPurpose } from './tokens'

/**
 * The alert flow itself (PJ-47): subscribe, confirm, manage, unsubscribe. The endpoints are thin
 * wrappers; everything that matters (tenancy, duplicates, tokens, settings) is decided here, so
 * it can be tested against a real database without HTTP.
 *
 * Every read and write is scoped to the tenant in the context, and every token is checked for
 * that tenant, so a link from one site does nothing on another.
 */

export const ALERTS_ADD_ON_KEY = 'alerts'

/** Where the site serves each page. Links in emails are the site's URL plus one of these. */
export type AlertPaths = { confirm: string; manage: string; unsubscribe: string }

export const DEFAULT_ALERT_PATHS: AlertPaths = {
  confirm: '/alerts/confirm',
  manage: '/alerts/manage',
  unsubscribe: '/alerts/unsubscribe',
}

export type AlertTenant = AccountTenant & Record<string, unknown>

export type AlertsContext = {
  /** The alerts collection slug (PJ-80). */
  alertsSlug: string
  /** Extra domains to refuse on top of the built-in disposable list. */
  blockedEmailDomains?: readonly string[]
  now?: Date
  paths?: AlertPaths
  payload: Payload
  /** The secret that signs links. The CMS secret is fine: the purpose is part of the signature. */
  secret: string
  sendEmail: AlertEmailSender
  slugs?: PayloadJobsCollectionSlugs
  tenant: AlertTenant
  /** Multi-tenant sites scope everything by tenant; a single-tenant site has no tenant field. */
  tenantScoped?: boolean
}

const ERRORS = {
  accountRequired: {
    code: 'account_required',
    message: 'Sign in to set up job alerts on this site.',
    status: 403,
  },
  alertsOff: { code: 'alerts_disabled', message: 'Job alerts are not available on this site.', status: 404 },
  badEmail: { code: 'invalid_email', message: 'Enter a valid email address.', status: 400 },
  badFilter: { code: 'invalid_filter', message: 'That search cannot be saved as an alert.', status: 400 },
  badFrequency: { code: 'invalid_frequency', message: 'Choose daily or weekly.', status: 400 },
  disposable: {
    code: 'disposable_email',
    message: 'Use a permanent email address: temporary mailboxes cannot receive alerts.',
    status: 400,
  },
  emailNotConfigured: {
    code: 'email_not_configured',
    message: 'Email is not set up for this site yet.',
    status: 503,
  },
  invalidToken: { code: 'invalid_token', message: 'This link is invalid or has expired.', status: 400 },
  notConfigured: {
    code: 'tenant_not_configured',
    message: 'This site has no domain to build links with.',
    status: 500,
  },
  notFound: { code: 'alert_not_found', message: 'That alert does not exist.', status: 404 },
} as const

const scopeWhere = (context: AlertsContext): Where[] =>
  context.tenantScoped === false ? [] : [{ tenant: { equals: context.tenant.id } }]

const siteURL = (context: AlertsContext): string => {
  const url = tenantSiteURL(context.tenant)
  if (!url) throw new AccountAuthError(ERRORS.notConfigured)

  return url
}

const link = (context: AlertsContext, kind: keyof AlertPaths, token: string): string =>
  `${siteURL(context)}${(context.paths ?? DEFAULT_ALERT_PATHS)[kind]}/${token}`

const sign = (context: AlertsContext, purpose: AlertTokenPurpose, subject: string): Promise<string> =>
  signAlertToken({
    now: context.now,
    purpose,
    secret: context.secret,
    subject,
    tenant: context.tenant.id,
  })

const verify = async (
  context: AlertsContext,
  purpose: AlertTokenPurpose,
  token: unknown,
): Promise<string> => {
  const result =
    typeof token === 'string'
      ? await verifyAlertToken({
          now: context.now,
          purpose,
          secret: context.secret,
          tenant: context.tenant.id,
          token,
        })
      : null
  if (!result) throw new AccountAuthError(ERRORS.invalidToken)

  return result.subject
}

/** The unsubscribe link for one alert. PJ-48's digest puts it in every email and header. */
export const alertUnsubscribeURL = async (
  context: Pick<AlertsContext, 'now' | 'paths' | 'secret' | 'tenant'>,
  alertID: number | string,
): Promise<string> => {
  const token = await signAlertToken({
    now: context.now,
    purpose: 'unsubscribe',
    secret: context.secret,
    subject: String(alertID),
    tenant: context.tenant.id,
  })
  const base = tenantSiteURL(context.tenant)
  if (!base) throw new AccountAuthError(ERRORS.notConfigured)

  return `${base}${(context.paths ?? DEFAULT_ALERT_PATHS).unsubscribe}/${token}`
}

/** The "manage my alerts" link for one address. */
export const alertManageURL = async (
  context: Pick<AlertsContext, 'now' | 'paths' | 'secret' | 'tenant'>,
  email: string,
): Promise<string> => {
  const token = await signAlertToken({
    now: context.now,
    purpose: 'manage',
    secret: context.secret,
    subject: email,
    tenant: context.tenant.id,
  })
  const base = tenantSiteURL(context.tenant)
  if (!base) throw new AccountAuthError(ERRORS.notConfigured)

  return `${base}${(context.paths ?? DEFAULT_ALERT_PATHS).manage}/${token}`
}

/**
 * The headers RFC 8058 wants on every alert email, so mail clients show their own Unsubscribe
 * button. The URL must accept a POST: the site's unsubscribe route does.
 */
export const alertUnsubscribeHeaders = (unsubscribeURL: string): Record<string, string> => ({
  'List-Unsubscribe': `<${unsubscribeURL}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
})

export const assertAlertsEnabled = (context: Pick<AlertsContext, 'tenant'>): void => {
  if (!isAddOnEnabled(context.tenant as { addOns?: unknown }, ALERTS_ADD_ON_KEY)) {
    throw new AccountAuthError(ERRORS.alertsOff)
  }
}

type RawAlert = {
  active?: boolean | null
  categories?: ({ id: number | string; name?: string } | number | string)[] | null
  confirmed?: boolean | null
  email: string
  filterKey?: null | string
  frequency?: AlertFrequency | null
  id: number | string
  keywords?: null | string
  locations?: ({ id: number | string; name?: string } | number | string)[] | null
  types?: ({ id: number | string; name?: string } | number | string)[] | null
}

/** What a subscriber is shown about an alert: no address, no ids of anyone else's data. */
export type AlertSummary = {
  active: boolean
  confirmed: boolean
  frequency: AlertFrequency
  id: number | string
  /** The search in words, e.g. `"nurse" · IT · Efate`. */
  summary: string
}

const nameOf = (entry: NonNullable<RawAlert['categories']>[number]): string =>
  typeof entry === 'object' ? (entry.name ?? '') : ''

/** The search as a sentence; an alert with no filters is "All jobs". */
export const describeAlert = (alert: RawAlert): string => {
  const parts = [
    alert.keywords ? `“${alert.keywords}”` : '',
    ...(alert.categories ?? []).map(nameOf),
    ...(alert.types ?? []).map(nameOf),
    ...(alert.locations ?? []).map(nameOf),
  ].filter(Boolean)

  return parts.length > 0 ? parts.join(' · ') : 'All jobs'
}

const toSummary = (alert: RawAlert): AlertSummary => ({
  active: alert.active !== false,
  confirmed: alert.confirmed === true,
  frequency: alert.frequency === 'weekly' ? 'weekly' : 'daily',
  id: alert.id,
  summary: describeAlert(alert),
})

const findOne = async (
  context: AlertsContext,
  where: Where[],
): Promise<null | RawAlert> => {
  const { docs } = await context.payload.find({
    collection: context.alertsSlug as CollectionSlug,
    depth: 1,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { and: [...scopeWhere(context), ...where] },
  })

  return (docs[0] as unknown as RawAlert | undefined) ?? null
}

const findForEmail = async (context: AlertsContext, email: string): Promise<RawAlert[]> => {
  const { docs } = await context.payload.find({
    collection: context.alertsSlug as CollectionSlug,
    depth: 1,
    limit: 200,
    overrideAccess: true,
    pagination: false,
    sort: 'createdAt',
    where: { and: [...scopeWhere(context), { email: { equals: email } }] },
  })

  return docs as unknown as RawAlert[]
}

/** Slugs to this tenant's own taxonomy ids. A slug that is not the tenant's is just unknown. */
const resolveFilters = async (
  context: AlertsContext,
  filters: AlertFilterValues,
): Promise<{
  categories: (number | string)[]
  keywords: null | string
  locations: (number | string)[]
  types: (number | string)[]
}> => {
  const slugs = context.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const lookup = async (collection: string, slug: string | undefined): Promise<(number | string)[]> => {
    if (!slug) return []

    const { docs } = await context.payload.find({
      collection: collection as CollectionSlug,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      where: { and: [...scopeWhere(context), { slug: { equals: slug } }] },
    })
    if (docs.length === 0) throw new AccountAuthError(ERRORS.badFilter)

    return [docs[0]!.id]
  }

  return {
    categories: await lookup(slugs.jobCategories, filters.category),
    keywords: filters.q ?? null,
    locations: await lookup(slugs.locations, filters.location),
    types: await lookup(slugs.jobTypes, filters.type),
  }
}

const sendAlertEmail = async (
  context: AlertsContext,
  event: AlertEmailEvent,
  doc: AlertEmailDoc,
): Promise<void> => {
  try {
    await context.sendEmail(event, doc, { alertsSlug: context.alertsSlug, payload: context.payload })
  } catch (error) {
    context.payload.logger.error({ err: error, event, msg: 'alerts: email failed' })
    throw new AccountAuthError(ERRORS.emailNotConfigured)
  }
}

const siteName = (context: AlertsContext): string => context.tenant.name ?? context.tenant.slug

export type SubscribeInput = {
  email: unknown
  /** Listing-shaped filters: `q`, `category`, `type`, `location`. */
  filters?: unknown
  frequency?: unknown
  /**
   * The signed-in visitor, when the endpoint saw one for this tenant. Their address is already
   * verified, so their alert starts confirmed without a second email.
   */
  user?: { email: string } | null
}

/**
 * Save a search. `pending` means a confirmation email is on its way; `subscribed` means the
 * alert is already live (double opt-in off, or a verified signed-in user).
 *
 * The same address and search never makes a second row. A repeat request is answered exactly
 * like the first one, so the response does not say whether the address was already known.
 */
export const subscribeToAlert = async (
  context: AlertsContext,
  input: SubscribeInput,
): Promise<{ status: 'pending' | 'subscribed' }> => {
  assertAlertsEnabled(context)
  const settings = alertSettings(context.tenant)

  if (!settings.allowWithoutAccount && !input.user) {
    throw new AccountAuthError(ERRORS.accountRequired)
  }

  const email = normaliseSubscriberEmail(settings.allowWithoutAccount ? input.email : input.user?.email)
  if (!email) throw new AccountAuthError(ERRORS.badEmail)
  if (isDisposableEmail(email, context.blockedEmailDomains)) throw new AccountAuthError(ERRORS.disposable)

  const frequency = input.frequency === undefined || input.frequency === '' ? 'daily' : input.frequency
  if (!(ALERT_FREQUENCIES as readonly unknown[]).includes(frequency)) {
    throw new AccountAuthError(ERRORS.badFrequency)
  }

  let filters: AlertFilterValues
  try {
    filters = normaliseAlertFilterInput(input.filters)
  } catch {
    throw new AccountAuthError(ERRORS.badFilter)
  }
  const resolved = await resolveFilters(context, filters)

  const live = !settings.doubleOptIn || Boolean(input.user && normaliseSubscriberEmail(input.user.email) === email)
  const status = live ? 'subscribed' : 'pending'

  const existing = await findForEmail(context, email)
  const filterKey = alertFilterKey(resolved)
  const sameSearch = existing.find((alert) => (alert.filterKey ?? '') === filterKey)

  if (sameSearch) {
    if (sameSearch.confirmed) {
      // Already live: the address is known to be theirs, so point them at their alerts.
      if (settings.doubleOptIn) await sendManageLink(context, email)
      return { status }
    }

    // Still waiting for confirmation: the latest ask wins, so the email and the row agree.
    await context.payload.update({
      collection: context.alertsSlug as CollectionSlug,
      data: { ...(live ? { confirmed: true } : {}), frequency } as never,
      id: sameSearch.id,
      overrideAccess: true,
    })
    if (!live) await sendConfirmation(context, { ...sameSearch, frequency: frequency as AlertFrequency }, email)

    return { status }
  }

  // Only alerts the owner confirmed count toward the cap. A stranger can ask for alerts on
  // someone's address, but never confirm one, so they must not be able to use up the owner's
  // room. Their unconfirmed ones are capped too, by replacing the oldest.
  const confirmed = existing.filter((alert) => alert.confirmed === true)
  if (confirmed.length >= settings.maxPerEmail) {
    // At the limit. Answer exactly as for any other request, so the form cannot be used to
    // learn that an address has the maximum, and send the manage link: that is where the owner
    // can delete one to make room.
    await sendManageLink(context, email)
    return { status }
  }

  const pending = existing.filter((alert) => alert.confirmed !== true)
  for (const stale of pending.slice(0, Math.max(0, pending.length - settings.maxPerEmail + 1))) {
    await context.payload.delete({
      collection: context.alertsSlug as CollectionSlug,
      id: stale.id,
      overrideAccess: true,
    })
  }

  let created: RawAlert
  try {
    created = (await context.payload.create({
      collection: context.alertsSlug as CollectionSlug,
      data: {
        active: true,
        categories: resolved.categories,
        confirmed: live,
        email,
        frequency,
        keywords: resolved.keywords,
        locations: resolved.locations,
        types: resolved.types,
        ...(context.tenantScoped === false ? {} : { tenant: context.tenant.id }),
      } as never,
      depth: 1,
      overrideAccess: true,
    })) as unknown as RawAlert
  } catch (error) {
    // A concurrent request for the same search won the unique index: that is a duplicate, not
    // a failure, and the other request is sending the email.
    const raced = await findOne(context, [
      { email: { equals: email } },
      { filterKey: { equals: filterKey } },
    ]).catch(() => null)
    if (raced) return { status }
    throw error
  }

  if (!live) await sendConfirmation(context, created, email)

  return { status }
}

const sendConfirmation = async (
  context: AlertsContext,
  alert: RawAlert,
  email: string,
): Promise<void> => {
  const full = (await findOne(context, [{ id: { equals: alert.id } }])) ?? alert
  const confirmToken = await sign(context, 'confirm', String(alert.id))

  await sendAlertEmail(context, 'alert-confirm', {
    email,
    id: alert.id,
    tenant: context.tenant.id,
    variables: {
      alertSummary: describeAlert(full),
      confirmUrl: link(context, 'confirm', confirmToken),
      frequency: full.frequency === 'weekly' ? 'weekly' : 'daily',
      manageUrl: link(context, 'manage', await sign(context, 'manage', email)),
      siteName: siteName(context),
    },
  })
}

const sendManageLink = async (context: AlertsContext, email: string): Promise<void> => {
  await sendAlertEmail(context, 'alert-manage-link', {
    email,
    tenant: context.tenant.id,
    variables: {
      manageUrl: link(context, 'manage', await sign(context, 'manage', email)),
      siteName: siteName(context),
    },
  })
}

/**
 * Someone who lost their manage link asks for a new one. It is only sent to an address that has
 * a confirmed alert here, but the answer is the same either way, so the form cannot be used to
 * find out who subscribes.
 */
export const requestManageLink = async (context: AlertsContext, emailInput: unknown): Promise<void> => {
  assertAlertsEnabled(context)

  const email = normaliseSubscriberEmail(emailInput)
  if (!email) throw new AccountAuthError(ERRORS.badEmail)

  const alerts = await findForEmail(context, email)
  if (alerts.some((alert) => alert.confirmed === true)) await sendManageLink(context, email)
}

export type ConfirmResult = { alert: AlertSummary; manageToken: string }

/** Follow the double opt-in link. Following it twice is harmless. */
export const confirmAlert = async (context: AlertsContext, token: unknown): Promise<ConfirmResult> => {
  assertAlertsEnabled(context)
  const id = await verify(context, 'confirm', token)

  const alert = await findOne(context, [{ id: { equals: id } }])
  if (!alert) throw new AccountAuthError(ERRORS.invalidToken)

  if (alert.confirmed !== true) {
    await context.payload.update({
      collection: context.alertsSlug as CollectionSlug,
      data: { confirmed: true } as never,
      id: alert.id,
      overrideAccess: true,
    })
  }

  return {
    alert: toSummary({ ...alert, confirmed: true }),
    manageToken: await sign(context, 'manage', alert.email),
  }
}

/** The alerts behind a manage link: this address, this site, nothing else. */
export const listAlerts = async (context: AlertsContext, token: unknown): Promise<AlertSummary[]> => {
  assertAlertsEnabled(context)
  const email = await verify(context, 'manage', token)

  return (await findForEmail(context, email)).map(toSummary)
}

export type AlertPatch = { active?: unknown; frequency?: unknown }

export const updateAlert = async (
  context: AlertsContext,
  token: unknown,
  id: unknown,
  patch: AlertPatch,
): Promise<AlertSummary> => {
  assertAlertsEnabled(context)
  const email = await verify(context, 'manage', token)

  const data: Record<string, unknown> = {}
  if (patch.frequency !== undefined) {
    if (!(ALERT_FREQUENCIES as readonly unknown[]).includes(patch.frequency)) {
      throw new AccountAuthError(ERRORS.badFrequency)
    }
    data.frequency = patch.frequency
  }
  if (patch.active !== undefined) data.active = patch.active === true || patch.active === 'true' || patch.active === 'on'

  const alert =
    typeof id === 'string' || typeof id === 'number'
      ? await findOne(context, [{ id: { equals: id } }, { email: { equals: email } }])
      : null
  if (!alert) throw new AccountAuthError(ERRORS.notFound)

  if (Object.keys(data).length > 0) {
    await context.payload.update({
      collection: context.alertsSlug as CollectionSlug,
      data: data as never,
      id: alert.id,
      overrideAccess: true,
    })
  }

  return toSummary({ ...alert, ...data } as RawAlert)
}

/** Delete one alert from the manage page. Only the address's own alert on this site. */
export const removeAlert = async (context: AlertsContext, token: unknown, id: unknown): Promise<void> => {
  assertAlertsEnabled(context)
  const email = await verify(context, 'manage', token)

  const alert =
    typeof id === 'string' || typeof id === 'number'
      ? await findOne(context, [{ id: { equals: id } }, { email: { equals: email } }])
      : null
  if (!alert) throw new AccountAuthError(ERRORS.notFound)

  await context.payload.delete({
    collection: context.alertsSlug as CollectionSlug,
    id: alert.id,
    overrideAccess: true,
  })
}

/**
 * One-click unsubscribe: the alert is deleted, because an address that asked to stop should not
 * stay on file. Only this alert goes; the address's others keep running. The link keeps
 * answering after the alert is gone, so a second click, or a mail client's own POST, is fine.
 */
export const unsubscribeAlert = async (
  context: AlertsContext,
  token: unknown,
): Promise<{ already: boolean }> => {
  assertAlertsEnabled(context)
  const id = await verify(context, 'unsubscribe', token)

  const alert = await findOne(context, [{ id: { equals: id } }])
  if (!alert) return { already: true }

  await context.payload.delete({
    collection: context.alertsSlug as CollectionSlug,
    id: alert.id,
    overrideAccess: true,
  })

  return { already: false }
}

export { alertQueryString }

/**
 * Delete alerts nobody confirmed within the confirm link's lifetime. They hold an address that
 * never agreed to anything, and their links can no longer be used. Runs for every site at once:
 * the rule is the same everywhere, and confirmed alerts are never touched. Returns how many went.
 */
export const purgeUnconfirmedAlerts = async (
  payload: Payload,
  { alertsSlug, now = new Date() }: { alertsSlug: string; now?: Date },
): Promise<number> => {
  const ttl = ALERT_TOKEN_TTL_MS.confirm ?? 0
  const cutoff = new Date(now.getTime() - ttl).toISOString()
  let deleted = 0

  for (;;) {
    const { docs } = await payload.find({
      collection: alertsSlug as CollectionSlug,
      depth: 0,
      limit: 100,
      overrideAccess: true,
      pagination: false,
      where: { and: [{ confirmed: { not_equals: true } }, { createdAt: { less_than: cutoff } }] },
    })
    if (docs.length === 0) return deleted

    for (const doc of docs) {
      await payload.delete({ collection: alertsSlug as CollectionSlug, id: doc.id, overrideAccess: true })
      deleted += 1
    }
  }
}

export const PURGE_UNCONFIRMED_ALERTS_TASK = 'purge-unconfirmed-alerts'

/** The daily task that runs `purgeUnconfirmedAlerts`. Cron has six fields: seconds first. */
export const purgeUnconfirmedAlertsTask = ({
  alertsSlug,
  cron = '0 45 3 * * *',
  queue = 'hourly',
}: {
  alertsSlug: string
  cron?: string
  queue?: string
}): TaskConfig => ({
  slug: PURGE_UNCONFIRMED_ALERTS_TASK as TaskSlug,
  handler: async ({ req }) => ({
    output: {
      alertsDeleted: await purgeUnconfirmedAlerts(req.payload, { alertsSlug }),
      mailSlotsDeleted: await purgeStaleMailSlots(req.payload),
    },
  }),
  outputSchema: [
    { name: 'alertsDeleted', type: 'number' },
    { name: 'mailSlotsDeleted', type: 'number' },
  ],
  schedule: [{ cron, queue }],
})
