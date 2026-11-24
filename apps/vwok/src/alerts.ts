import {
  confirmNotice,
  createAlertsClient,
  manageLinkNotice,
  readManageForm,
  readSubscribeForm,
  subscribeNotice,
  unsubscribeNotice,
  type AlertNotice,
  type AlertsClient,
  type AlertSummary,
} from '@mission-control/launchpad/alerts'

import type { CmsClient } from '@mission-control/launchpad/cms'
import { loadSite, type MenuView } from '@mission-control/launchpad/pages'
import { resolveLocale } from '@mission-control/launchpad/tenant/locale'

import { siteTenant } from './brand'
import { SITE_COLLECTIONS } from './site'

/**
 * The alert pages' logic (PJ-47): what each route does with a request, as plain functions of a
 * client, so it is tested without a Worker. The Astro pages only render what these return.
 *
 * Every page here is private to whoever holds the link: it is never cached, never indexed, and
 * sends no referrer (the link is the secret).
 */

export type AlertsEnv = { CMS_URL?: string; PUBLIC_TURNSTILE_SITE_KEY?: string; SITE_KEY?: string }

export const alertsClientFromEnv = (env: AlertsEnv): AlertsClient | null => {
  const baseUrl = env.CMS_URL?.trim()
  const siteKey = env.SITE_KEY?.trim()
  const tenantSlug = siteTenant.slug
  if (!baseUrl || !siteKey || !tenantSlug) return null

  return createAlertsClient({ baseUrl, siteKey, tenantSlug })
}

export const ALERT_PAGE_HEADERS = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
} as const

export type AlertPage =
  | { kind: 'manage-list'; alerts: AlertSummary[]; message?: string; status: number }
  | { kind: 'manage-request'; notice?: AlertNotice; status: number }
  | { kind: 'notice'; notice: AlertNotice; status: number }
  | { kind: 'one-click'; status: number }
  | { kind: 'redirect'; location: string }
  | { kind: 'unsubscribe-form'; status: number }

const notConfigured: AlertPage = {
  kind: 'notice',
  notice: {
    kind: 'error',
    message: 'Job alerts are not available right now. Please try again later.',
    title: 'Job alerts are unavailable',
  },
  status: 503,
}

/** The CMS tells us what went wrong; the status tells search engines and monitors. */
const statusFor = (reply: { ok: true } | { ok: false; status: number }): number => {
  if (reply.ok) return 200
  const { status } = reply
  // 0 is "the CMS did not answer"; a CMS error is the site's bad gateway, not the visitor's fault.
  if (status === 0 || status >= 500) return 502
  return status === 429 || status === 404 ? status : 400
}

type Visitor = { clientIp?: null | string }

/** `POST /alerts/subscribe` from the "Get these jobs by email" form. */
export const subscribePage = async (
  client: AlertsClient | null,
  request: Request,
  { clientIp }: Visitor = {},
): Promise<AlertPage> => {
  if (request.method !== 'POST') return { kind: 'redirect', location: '/jobs' }
  if (!client) return notConfigured

  const form = readSubscribeForm(await request.formData().catch(() => new FormData()))
  const reply = await client.subscribe({ ...form, clientIp })

  return { kind: 'notice', notice: subscribeNotice(reply), status: statusFor(reply) }
}

/** `GET /alerts/confirm/:token`: the double opt-in link. */
export const confirmPage = async (
  client: AlertsClient | null,
  token: string,
  { clientIp }: Visitor = {},
): Promise<AlertPage> => {
  if (!client) return notConfigured
  const reply = await client.confirm({ clientIp, token })

  return { kind: 'notice', notice: confirmNotice(reply), status: statusFor(reply) }
}

/** `/alerts/manage`: ask for a link to be emailed. */
export const manageRequestPage = async (
  client: AlertsClient | null,
  request: Request,
  { clientIp }: Visitor = {},
): Promise<AlertPage> => {
  if (request.method !== 'POST') return { kind: 'manage-request', status: 200 }
  if (!client) return notConfigured

  const data = await request.formData().catch(() => new FormData())
  const reply = await client.requestManageLink({
    clientIp,
    email: String(data.get('email') ?? '').trim(),
    honeypot: String(data.get('alert_website') ?? ''),
    turnstileToken: String(data.get('cf-turnstile-response') ?? ''),
  })

  return reply.ok
    ? { kind: 'notice', notice: manageLinkNotice(reply), status: 200 }
    : { kind: 'manage-request', notice: manageLinkNotice(reply), status: statusFor(reply) }
}

/** `/alerts/manage/:token`: list the alerts, and save or delete one. */
export const managePage = async (
  client: AlertsClient | null,
  request: Request,
  token: string,
  { clientIp }: Visitor = {},
): Promise<AlertPage> => {
  if (!client) return notConfigured

  let message: string | undefined

  if (request.method === 'POST') {
    const form = readManageForm(await request.formData().catch(() => new FormData()))
    const outcome =
      form.action === 'delete'
        ? await client.remove({ clientIp, id: form.id, token })
        : await client.update({
            active: form.active,
            clientIp,
            frequency: form.frequency,
            id: form.id,
            token,
          })

    if (!outcome.ok) {
      const notice = unsubscribeNotice(outcome)
      return { kind: 'notice', notice, status: statusFor(outcome) }
    }
    message = form.action === 'delete' ? 'The alert was deleted.' : 'Your changes were saved.'
  }

  const listed = await client.list({ clientIp, token })
  if (!listed.ok) {
    return { kind: 'notice', notice: unsubscribeNotice(listed), status: statusFor(listed) }
  }

  return { alerts: listed.alerts, kind: 'manage-list', message, status: 200 }
}

/**
 * `/alerts/unsubscribe/:token`.
 *
 * - A GET shows a page with one button and changes nothing: mail scanners and link previewers
 *   open every link in an email, and they must not be able to unsubscribe anyone.
 * - A POST unsubscribes. A mail client's own button (RFC 8058, `List-Unsubscribe=One-Click`)
 *   gets a bare 200; a person pressing our button gets the page.
 */
export const unsubscribePage = async (
  client: AlertsClient | null,
  request: Request,
  token: string,
  { clientIp }: Visitor = {},
): Promise<AlertPage> => {
  if (request.method !== 'POST') return { kind: 'unsubscribe-form', status: 200 }
  if (!client) return notConfigured

  const oneClick = (await request.clone().formData().catch(() => new FormData())).get('List-Unsubscribe') === 'One-Click'
  const reply = await client.unsubscribe({ clientIp, token })

  if (oneClick) return { kind: 'one-click', status: reply.ok ? 200 : statusFor(reply) }

  return { kind: 'notice', notice: unsubscribeNotice(reply), status: statusFor(reply) }
}

/** The site's menus, so an alert page has the same header and footer as the rest of the site. */
export const alertsChrome = async (cms: CmsClient | null): Promise<MenuView[]> => {
  if (!cms) return []

  try {
    return (
      await loadSite({
        cms,
        collections: SITE_COLLECTIONS,
        locale: resolveLocale(siteTenant),
        pathname: '/alerts',
        tenant: siteTenant,
      })
    ).menus
  } catch {
    // The alert page matters more than its menus: show it bare rather than not at all.
    return []
  }
}
