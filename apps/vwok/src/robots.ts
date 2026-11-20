import { PRODUCTION_HOSTNAMES } from './brand'

/** Loopback hosts are a developer's own machine, never a public duplicate of the site. */
const LOCAL_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

export const isProductionHost = (hostname: string): boolean =>
  PRODUCTION_HOSTNAMES.includes(hostname.toLowerCase())

/**
 * `robots.txt` for one hostname. Production is crawlable, and so is a developer's own machine so
 * Lighthouse sees a crawlable page. A Worker preview — including a `workers.dev` deployment —
 * serves the same pages as the live site and would be duplicate content, so it is blocked. The
 * sitemap reference arrives with the sitemap itself (PJ-40).
 */
export const robotsTxt = (hostname: string): string => {
  const host = hostname.toLowerCase()
  const crawlable = isProductionHost(host) || LOCAL_HOSTNAMES.includes(host)
  const rules = crawlable ? ['User-agent: *', 'Allow: /'] : ['User-agent: *', 'Disallow: /']

  return `${rules.join('\n')}\n`
}
