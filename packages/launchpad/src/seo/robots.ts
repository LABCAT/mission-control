/**
 * `robots.txt` as data: which areas stay private, where the sitemap is, and whether AI crawlers
 * may read the site.
 *
 * The rule comes from STATUS.md (19 Nov): robots allows public pages, blocks `/admin` and
 * `/account`, points at the sitemap, and carries a per-tenant AI-crawler switch. The switch
 * itself is built in PJ-104, so the default here is "allow" and a site app passes the tenant's
 * value once the setting exists.
 */

/** Areas no crawler may enter: the CMS admin, the account dashboards and the private API. */
export const PRIVATE_ROBOTS_PATHS: readonly string[] = ['/admin', '/account', '/alerts', '/api']

/**
 * The crawlers the AI switch covers. Naming them explicitly is what makes the switch work:
 * `User-agent: *` cannot turn a group off, only a group per crawler can.
 */
export const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'anthropic-ai',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'PerplexityBot',
  'Bytespider',
  'Amazonbot',
  'meta-externalagent',
]

export type RobotsOptions = {
  /** Let AI crawlers read the site. Default `true`: vwok has no switch yet (PJ-104). */
  allowAiCrawlers?: boolean
  /** False on a preview or a developer host: the whole site is a duplicate of production. */
  crawlable?: boolean
  /** Absolute sitemap URL. Omitted when the site has no canonical origin to name. */
  sitemapUrl?: null | string
}

const userAgentGroup = (agents: readonly string[], rules: readonly string[]): string[] => {
  if (agents.length === 0 || rules.length === 0) return []

  const lines = agents.map((agent) => `User-agent: ${agent}`)
  lines.push(...rules)

  return lines
}

/**
 * `robots.txt` for one site. A blocked site answers with a single `Disallow: /`, which every
 * crawler honours, and no sitemap: pointing a crawler at URLs it may not read is noise.
 *
 * The sitemap line is repeated in every group because a crawler reads only the group it
 * matched; one group's sitemap is not another's.
 */
export const robotsTxt = ({
  allowAiCrawlers = true,
  crawlable = true,
  sitemapUrl = null,
}: RobotsOptions = {}): string => {
  if (!crawlable) return 'User-agent: *\nDisallow: /\n'

  const privates = PRIVATE_ROBOTS_PATHS.map((path) => `Disallow: ${path}`)
  const sitemap = sitemapUrl?.trim() ? [`Sitemap: ${sitemapUrl.trim()}`] : []

  const groups = [
    userAgentGroup(['*'], [...privates, ...sitemap]),
    userAgentGroup(AI_CRAWLERS, allowAiCrawlers ? [...privates, ...sitemap] : ['Disallow: /']),
  ].filter((group) => group.length > 0)

  return `${groups.map((group) => group.join('\n')).join('\n\n')}\n`
}
