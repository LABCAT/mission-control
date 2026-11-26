/**
 * The site's side of the job alerts add-on (PJ-47): a small typed client for the CMS alert
 * endpoints. It runs on the server (an Astro route), so the site key never reaches a browser,
 * and the visitor's IP is forwarded so the CMS can rate limit the visitor, not the Worker.
 */

export const SITE_KEY_HEADER = 'x-site-key'
export const END_USER_IP_HEADER = 'x-end-user-ip'

export type AlertFrequency = 'daily' | 'weekly'

/** The listing's own filter names: an alert is the filter the visitor was looking at. */
export type AlertFilters = { category?: string; location?: string; q?: string; type?: string }

export type AlertSummary = {
  active: boolean
  confirmed: boolean
  frequency: AlertFrequency
  id: number | string
  summary: string
}

export type AlertsReply<T> =
  | ({ ok: true } & T)
  | { code: string; message: string; ok: false; status: number }

export type AlertsClientOptions = {
  baseUrl: string
  fetch?: typeof fetch
  siteKey: string
  tenantSlug: string
  timeoutMs?: number
}

type Call = { clientIp?: null | string }

export type SubscribeInput = Call & {
  /** Hidden bot trap; real visitors leave it empty. */
  honeypot?: string
  email: string
  filters?: AlertFilters
  frequency?: AlertFrequency
  turnstileToken?: string
  /** The signed-in visitor's session token (the `mc_session` cookie), for the alerts-need-an-account setting. */
  userToken?: string
}

export type AlertsClient = {
  confirm: (input: Call & { token: string }) => Promise<AlertsReply<{ alert: AlertSummary; manageToken: string }>>
  list: (input: Call & { token: string }) => Promise<AlertsReply<{ alerts: AlertSummary[] }>>
  remove: (input: Call & { id: number | string; token: string }) => Promise<AlertsReply<object>>
  requestManageLink: (
    input: Call & { email: string; honeypot?: string; turnstileToken?: string },
  ) => Promise<AlertsReply<object>>
  subscribe: (input: SubscribeInput) => Promise<AlertsReply<{ status: 'pending' | 'subscribed' }>>
  unsubscribe: (input: Call & { token: string }) => Promise<AlertsReply<{ already?: boolean }>>
  update: (
    input: Call & { active?: boolean; frequency?: AlertFrequency; id: number | string; token: string },
  ) => Promise<AlertsReply<{ alert: AlertSummary }>>
}

export const createAlertsClient = (options: AlertsClientOptions): AlertsClient => {
  const doFetch = options.fetch ?? fetch
  const base = `${options.baseUrl.replace(/\/+$/, '')}/api/tenants/${encodeURIComponent(options.tenantSlug)}/alerts`

  const post = async <T>(
    path: string,
    body: Record<string, unknown>,
    { clientIp, userToken }: Call & { userToken?: string } = {},
  ): Promise<AlertsReply<T>> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [SITE_KEY_HEADER]: options.siteKey,
    }
    if (clientIp) headers[END_USER_IP_HEADER] = clientIp
    // The account contract (docs/ACCOUNT-AUTH.md): the token travels as a bearer credential.
    if (userToken) headers.authorization = `Bearer ${userToken}`

    try {
      const response = await doFetch(`${base}/${path}`, {
        body: JSON.stringify(body),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      })
      const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null

      if (response.ok && parsed && parsed.ok === true) return parsed as AlertsReply<T>

      const error = (parsed?.error ?? {}) as { code?: string; message?: string }

      return {
        code: error.code ?? 'server_error',
        message: error.message ?? 'Something went wrong. Please try again.',
        ok: false,
        status: response.status,
      }
    } catch {
      return {
        code: 'network',
        message: 'We could not reach the job board just now. Please try again.',
        ok: false,
        status: 0,
      }
    }
  }

  return {
    confirm: ({ clientIp, token }) => post('confirm', { token }, { clientIp }),
    list: ({ clientIp, token }) => post('manage', { token }, { clientIp }),
    remove: ({ clientIp, id, token }) => post('manage/remove', { id, token }, { clientIp }),
    requestManageLink: ({ clientIp, email, honeypot, turnstileToken }) =>
      post('manage-link', { alert_website: honeypot ?? '', email, turnstileToken }, { clientIp }),
    subscribe: ({ clientIp, email, filters, frequency, honeypot, turnstileToken, userToken }) =>
      post(
        'subscribe',
        { alert_website: honeypot ?? '', email, filters, frequency, turnstileToken },
        { clientIp, userToken },
      ),
    unsubscribe: ({ clientIp, token }) => post('unsubscribe', { token }, { clientIp }),
    update: ({ active, clientIp, frequency, id, token }) =>
      post('manage/update', { active, frequency, id, token }, { clientIp }),
  }
}
