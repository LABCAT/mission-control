/**
 * The legacy URL answer, applied to a request before Astro routes it (PJ-42).
 *
 * A 301 is answered here rather than by a page because the redirect happens before any rendering:
 * no CMS read, no layout, no bytes. A 410 is *not* answered here: the app renders its "gone" page
 * with the status, so a visitor still gets navigation and a search box. `answerLegacy` returns
 * `null` for both "not a legacy URL" and "gone", and the caller tells them apart with
 * `legacyGone`, which keeps the decision table in one place.
 *
 * The answer is a plain `Response | null` so a test can call it with a `Request` and no Astro.
 */
import { legacyRedirect, type LegacyRedirectOptions } from './legacy-map'

/** Cache a permanent redirect hard: it never changes, and a crawler should not ask twice. */
const REDIRECT_CACHE_CONTROL = 'public, max-age=3600'

export type LegacyAnswer = { response: Response } | { gone: true } | null

/**
 * The response for a legacy request, `{ gone: true }` when the path is deliberately gone, or
 * `null` when the app's own routes should handle it.
 *
 * `HEAD` is answered like `GET`: a crawler checks a dead URL with `HEAD` first, and the status is
 * the whole answer either way.
 */
export const answerLegacy = (
  request: Pick<Request, 'method' | 'url'>,
  options: LegacyRedirectOptions = {},
): LegacyAnswer => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null

  const url = new URL(request.url)
  const target = legacyRedirect({ pathname: url.pathname, search: url.search }, options)
  if (!target) return null
  if (target.kind === 'gone') return { gone: true }

  return {
    response: new Response(null, {
      headers: { 'cache-control': REDIRECT_CACHE_CONTROL, location: target.location },
      status: target.status,
    }),
  }
}
