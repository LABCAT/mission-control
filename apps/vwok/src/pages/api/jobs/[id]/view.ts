/**
 * `POST /api/jobs/:id/view` — the site's own view beacon, which proxies to the CMS
 * (`POST /api/<jobs>/:id/view`, PJ-37).
 *
 * The proxy exists for two reasons: the site key stays on the server, and the CMS must see the
 * visitor's address rather than the Worker's, which it reads from `x-end-user-ip`. The CMS
 * decides everything else (bots, rate limit, live jobs, tenancy) and its answer is passed back
 * unchanged so the page can show the counts.
 */
import type { APIRoute } from 'astro'

import { siteEnv } from '../../../../env'
import { SITE_COLLECTIONS } from '../../../../site'

/** The CMS origin, or `null` when none is configured or it is not a URL. */
const cmsOrigin = (baseUrl: string | undefined): null | string => {
  try {
    return baseUrl?.trim() ? new URL(baseUrl.trim()).origin : null
  } catch {
    return null
  }
}

const noStore = { 'cache-control': 'no-store' } as const

const json = (body: unknown, status = 200): Response =>
  Response.json(body, { headers: noStore, status })

export const POST: APIRoute = async ({ clientAddress, params, request }) => {
  const id = params.id?.trim()
  if (!id || !/^[\w-]{1,64}$/.test(id)) return json({ error: 'not_found' }, 404)

  const env = await siteEnv()
  const origin = cmsOrigin(env.CMS_URL)
  const key = env.SITE_KEY?.trim()
  if (!origin || !key) return json({ error: 'not_configured' }, 503)

  const headers = new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'x-end-user-ip': clientAddress,
    'x-site-key': key,
  })
  const userAgent = request.headers.get('user-agent')
  if (userAgent) headers.set('user-agent', userAgent)

  let upstream: Response
  try {
    upstream = await fetch(`${origin}/api/${SITE_COLLECTIONS.jobs}/${encodeURIComponent(id)}/view`, {
      body: '{}',
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return json({ error: 'unavailable' }, 502)
  }

  const body = await upstream.text()

  return new Response(body, {
    headers: { ...noStore, 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    status: upstream.status,
  })
}
