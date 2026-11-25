/**
 * Answers the legacy URLs before anything else runs (PJ-42).
 *
 * A redirect is a `Response` from here, so it costs no rendering and no CMS read. A retired page
 * is different: it must still show navigation and a search box, so the middleware only records
 * the decision on `locals` and the catch-all page renders when it sees it. Without that split the
 * 410 would be a bare status with no page.
 */
import { defineMiddleware } from 'astro:middleware'

import { vwokLegacyAnswer } from './legacy-routes'

export const onRequest = defineMiddleware(async (context, next) => {
  const answer = vwokLegacyAnswer(context.request)

  if (answer === null) return next()
  if ('response' in answer) return answer.response

  // Gone: the page renders the 410 so the visitor keeps the site's own chrome.
  context.locals.legacyGone = true
  return next()
})
