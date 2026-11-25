/**
 * What an `/og/…` path names (PJ-105), and the card for it. Kept apart from the route files so
 * the mapping can be tested without a Worker.
 *
 * A route answers a PNG for a page the site also serves, or the page's own 404: a share image
 * must never advertise a page the site will not. The card is built from the same loaders the
 * pages use, so the image shows what the page shows.
 */
import type { CmsClient } from '@mission-control/launchpad/cms'
import { homeCard, jobCard, organisationCard, type OgCard } from '@mission-control/launchpad/og/card'
import { loadSite, pageView } from '@mission-control/launchpad/pages'

import { siteTenant } from './brand'
import { jobRoute } from './job-route'
import { organisationRoute } from './organisation-route'
import { SITE_COLLECTIONS } from './site'

export type OgRoute = { kind: 'home' } | { kind: 'job'; slug: string } | { kind: 'organisation'; slug: string }

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * `/og/jobs/{slug}.png`, `/og/organisations/{slug}.png`, `/og/home.png`. The `.png` suffix is
 * part of the route: the decision is PNG, and no other format is served from this path.
 */
export const ogRoute = (pathname: string): OgRoute | null => {
  // A trailing slash is the same image, so `/og/jobs/x.png/` resolves too.
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  if (path === '/og/home.png') return { kind: 'home' }

  const match = /^\/og\/(jobs|organisations)\/([^/]+)\.png$/.exec(path)
  if (!match) return null

  const slug = decode(match[2]!).trim()
  if (!slug) return null

  return match[1] === 'jobs' ? { kind: 'job', slug } : { kind: 'organisation', slug }
}

/** The path the pages put in their share tags, for a route this module resolved. */
export const ogImagePath = (route: OgRoute): string =>
  route.kind === 'home'
    ? '/og/home.png'
    : `/og/${route.kind === 'job' ? 'jobs' : 'organisations'}/${encodeURIComponent(route.slug)}.png`

export type OgCardResult = { kind: 'card'; card: OgCard; key: string } | { kind: 'not-found' }

export type OgCardOptions = {
  cms: CmsClient | null
  now?: Date
  /** The deployment's origin, so a site logo given as a path is absolute. */
  origin?: string
  route: OgRoute
}

/**
 * The card for one route. A job or organisation is `not-found` exactly when its page is; the home
 * page is always a card, because the site serves `/` even with no CMS configured (its shell).
 */
export const ogCardFor = async ({ cms, now, origin, route }: OgCardOptions): Promise<OgCardResult> => {
  if (route.kind === 'job') {
    const result = await jobRoute({ cms, now, siteUrl: origin, slug: route.slug })
    if (result.kind !== 'job') return { kind: 'not-found' }

    return { card: jobCard({ origin, view: result.view }), key: `jobs/${route.slug}`, kind: 'card' }
  }

  if (route.kind === 'organisation') {
    const result = await organisationRoute({ cms, slug: route.slug })
    if (result.kind !== 'found') return { kind: 'not-found' }

    return {
      card: organisationCard({ origin, profile: result.profile, tenant: siteTenant }),
      key: `organisations/${route.slug}`,
      kind: 'card',
    }
  }

  const site = cms
    ? await loadSite({
        cms,
        collections: SITE_COLLECTIONS,
        pathname: '/',
        tenant: siteTenant,
      })
    : null
  const view = site?.kind === 'page' ? pageView(site, { tenant: siteTenant }) : null

  return {
    card: homeCard({
      ...(view?.metadata.description ? { description: view.metadata.description } : {}),
      ...(origin ? { origin } : {}),
      tenant: siteTenant,
      ...(view ? { title: view.metadata.title } : {}),
    }),
    key: 'home',
    kind: 'card',
  }
}
