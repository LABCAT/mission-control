import { robotsTxt as themeRobotsTxt } from '@mission-control/launchpad/seo/robots'

import { PRODUCTION_HOSTNAMES } from './brand'

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

export type RobotsOptions = {
  /** The tenant's AI-crawler setting (PJ-104); allow until the setting exists. */
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
