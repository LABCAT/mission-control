/**
 * `/og/jobs/{slug}.png`, `/og/organisations/{slug}.png`, `/og/home.png` (PJ-105).
 *
 * One catch-all rather than a file per shape, because the match is a data question (`ogRoute`):
 * a path this module does not recognise is a 404, whether or not it looks like a share image.
 *
 * The image is generated on first request from the same data the page renders, stored in R2 and
 * edge-cached. Its version is the card's digest, so when the job or the tenant changes the next
 * request misses both caches and regenerates; nothing has to purge the old image.
 */
import type { APIRoute } from 'astro'

import { cardVersion, ogKey, servedPng } from '@mission-control/launchpad/og/store'
import { ogRenderer } from '@mission-control/launchpad/og/worker'

import { siteEnv } from '../../env'
import { ogCardFor, ogRoute } from '../../og-route'
import { cmsFromEnv } from '../../site'

const notFound = (): Response =>
  new Response('Not found', { headers: { 'content-type': 'text/plain' }, status: 404 })

export const GET: APIRoute = async ({ params, site, url }) => {
  // `path` is the catch-all without its prefix, so put `/og` back before matching.
  const route = ogRoute(`/og/${params.path ?? ''}`)
  if (!route) return notFound()

  const origin = site?.origin ?? url.origin
  const env = await siteEnv()
  const result = await ogCardFor({ cms: cmsFromEnv(env), origin, route })
  if (result.kind === 'not-found') return notFound()

  const version = await cardVersion(result.card)
  const key = ogKey(result.card.kind, result.card.siteName, result.key)

  return servedPng(key, version, () => ogRenderer().png(result.card), {
    ...(env.OG_IMAGES ? { bucket: env.OG_IMAGES } : {}),
    namespace: `og:${origin}`,
  })
}
