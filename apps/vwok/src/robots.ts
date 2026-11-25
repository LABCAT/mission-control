import type { CmsTenantSettings } from '@mission-control/launchpad/cms'
import { tenantFromSettings } from '@mission-control/launchpad/cms'
import { robotsTxt as themeRobotsTxt, tenantAllowsAiCrawlers } from '@mission-control/launchpad/seo/robots'

import { PRODUCTION_HOSTNAMES, siteTenant } from './brand'
import { aiCrawlersAllowed, type SiteEnv } from './env'

/** Loopback hosts are a developer's own machine, never a public duplicate of the site. */
const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

export const isProductionHost = (hostname: string): boolean =>
  PRODUCTION_HOSTNAMES.includes(hostname.toLowerCase())

/**
 * A host may be crawled in production or on a developer's own machine, so Lighthouse sees a
 * crawlable page. A Worker preview — including a `workers.dev` deployment — serves the same
 * pages as the site and would be duplicate content, so it is blocked.
 */
export const isCrawlableHost = (hostname: string): boolean =>
  isProductionHost(hostname) || LOCAL_HOSTNAMES.includes(hostname.toLowerCase())

/**
 * Whether AI crawlers may read this site (PJ-104). The tenant's setting is the answer; the
 * deployment's `AI_CRAWLERS_ALLOWED` only applies to a site with no CMS at all, so a local
 * checkout and the Lighthouse run keep answering. A settings read that failed is passed as
 * `null` and also falls back to the deployment switch, so a CMS blip never changes the answer.
 */
export const allowAiCrawlersFor = ({
  env,
  settings,
}: {
  env: SiteEnv
  settings: CmsTenantSettings | null
}): boolean =>
  settings ? tenantAllowsAiCrawlers(tenantFromSettings(settings, siteTenant)) : aiCrawlersAllowed(env)

export type RobotsOptions = {
  /** The tenant's AI-crawler setting (PJ-104). Defaults to allow, the setting's own default. */
  aiCrawlersAllowed?: boolean
  /** Absolute sitemap URL. Omitted only where there is no canonical origin to name. */
  sitemapUrl?: null | string
}

/**
 * `robots.txt` for one hostname. Which paths stay private and how AI crawlers are treated come
 * from the theme, so every site answers the same way; this app only decides whether the host is
 * the live site.
 */
export const robotsTxt = (
  hostname: string,
  { aiCrawlersAllowed = true, sitemapUrl = null }: RobotsOptions = {},
): string =>
  themeRobotsTxt({
    allowAiCrawlers: aiCrawlersAllowed,
    crawlable: isCrawlableHost(hostname),
    sitemapUrl,
  })
