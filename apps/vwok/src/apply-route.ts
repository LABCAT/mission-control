import type { CmsClient } from '@mission-control/launchpad/cms'
import { applyOutcome, applyPath, signInPath, type ApplyOutcome } from '@mission-control/launchpad/jobs/apply'
import type { JobDetailView } from '@mission-control/launchpad/jobs/detail'
import { readCookie, SESSION_COOKIE } from '@mission-control/launchpad/view-as'

import { jobRoute } from './job-route'
import { SITE_COLLECTIONS } from './site'

/**
 * `/jobs/{slug}/apply` (PJ-45). The page and the proxy to the CMS apply endpoint, as plain
 * functions so they are tested without a Worker. The proxy exists for the same reasons as the
 * view beacon's: the site key stays on the server and the CMS must see the visitor's address.
 * The employer's address is resolved by the CMS and never reaches this site.
 */

export type ApplyRoute =
  | { kind: 'closed'; message: string; view: JobDetailView }
  | { kind: 'form'; view: JobDetailView }
  | { kind: 'not-found' }
  | { kind: 'redirect'; location: string }

export const applyRoute = async ({
  cms,
  cookie,
  now,
  slug,
}: {
  cms: Pick<CmsClient, 'find' | 'findBySlug' | 'tenantSettings'> | null
  cookie: null | string
  now?: Date
  slug: string
}): Promise<ApplyRoute> => {
  const route = await jobRoute({ cms, now, slug })
  if (route.kind !== 'job') return { kind: 'not-found' }

  const { view } = route

  if (view.expired) {
    return { kind: 'closed', message: 'This job is no longer accepting applications.', view }
  }
  if (view.applyMode === 'none' || view.applyMode === 'how-to') {
    return { kind: 'closed', message: 'This job does not take online applications. See how to apply on the job page.', view }
  }

  // A cached job page cannot know who is looking, so the check is here, on an uncached page.
  // The CMS checks the session again on the POST: this redirect is a courtesy, not the gate.
  if (view.applyMode === 'sign-in' && !readCookie(cookie, SESSION_COOKIE)) {
    return { kind: 'redirect', location: signInPath(applyPath(slug)) }
  }

  return { kind: 'form', view }
}

const cmsOrigin = (baseUrl: string | undefined): null | string => {
  try {
    return baseUrl?.trim() ? new URL(baseUrl.trim()).origin : null
  } catch {
    return null
  }
}

const GENERIC_ERROR: ApplyOutcome = {
  kind: 'error',
  message: 'We could not send your application. Please try again.',
}

/** Forward the visitor's multipart form to the CMS and read its answer. */
export const forwardApplication = async ({
  clientAddress,
  env,
  fetcher = fetch,
  jobId,
  request,
}: {
  clientAddress: string
  env: { CMS_URL?: string; SITE_KEY?: string }
  fetcher?: typeof fetch
  jobId: number | string
  request: Request
}): Promise<ApplyOutcome> => {
  const origin = cmsOrigin(env.CMS_URL)
  const key = env.SITE_KEY?.trim()
  if (!origin || !key) return GENERIC_ERROR

  let incoming: FormData
  try {
    incoming = await request.formData()
  } catch {
    return GENERIC_ERROR
  }

  const headers = new Headers({
    accept: 'application/json',
    'x-end-user-ip': clientAddress,
    'x-site-key': key,
  })
  const userAgent = request.headers.get('user-agent')
  if (userAgent) headers.set('user-agent', userAgent)

  // The session is forwarded so the CMS can tell a signed-in applicant from a guest.
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE)
  if (token) headers.set('authorization', `JWT ${token}`)

  let upstream: Response
  try {
    upstream = await fetcher(`${origin}/api/${SITE_COLLECTIONS.jobs}/${encodeURIComponent(String(jobId))}/apply`, {
      body: incoming,
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(25_000),
    })
  } catch {
    return GENERIC_ERROR
  }

  return applyOutcome(upstream.status, await upstream.json().catch(() => null))
}
