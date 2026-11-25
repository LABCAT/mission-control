/**
 * `/llms.txt` for this site (PJ-104): the agent-friendly summary an AI crawler reads first.
 *
 * The file's content is built in `@mission-control/launchpad/seo`; this module supplies the CMS
 * client, the tenant and the canonical origin, exactly as `sitemap.ts` does.
 */
import { createCmsClient, type CacheLike } from '@mission-control/launchpad/cms'
import { serveLlms, type LlmsCms } from '@mission-control/launchpad/seo/llms-serve'

import { siteTenant } from './brand'
import { siteEnv, type SiteEnv } from './env'

export type SiteLlmsOptions = {
  /** Edge cache; defaults to `caches.default`. */
  cache?: CacheLike
  /** A CMS client to read from; a test passes a stub instead of hitting the network. */
  cms?: LlmsCms
  /** Defaults to the Worker's environment; a test passes one directly. */
  env?: SiteEnv
  /** The clock that decides which jobs are live. */
  now?: Date
  /** The canonical origin from `astro.config.mjs` (`site`). */
  siteUrl: null | string
}

/**
 * Without a CMS URL and site key there is nothing to enumerate, so the route answers 404 rather
 * than a file listing nothing. A site with no canonical origin answers 404 too, inside
 * `serveLlms`, because the file is made of absolute URLs.
 */
export const siteLlms = async ({
  cache,
  cms: givenCms,
  env: givenEnv,
  now,
  siteUrl,
}: SiteLlmsOptions): Promise<Response> => {
  const env = givenEnv ?? (await siteEnv())
  const cmsUrl = env.CMS_URL?.trim()
  const siteKey = env.SITE_KEY?.trim()

  if (!cmsUrl || !siteKey) {
    return new Response('llms.txt is not configured', {
      headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
      status: 404,
    })
  }

  return serveLlms({
    cache,
    cms: givenCms ?? createCmsClient({ baseUrl: cmsUrl, siteKey }),
    ...(now ? { now } : {}),
    site: siteTenant.slug ?? 'site',
    siteUrl,
    tenant: siteTenant,
  })
}
