import { describe, expect, it } from 'vitest'

import { AI_CRAWLERS, PRIVATE_ROBOTS_PATHS, robotsTxt } from './robots'

const SITEMAP = 'https://vanuatuwok.vu/sitemap.xml'

/** Split a robots.txt into its groups: the user-agent lines and the rules that follow them. */
const groups = (text: string): { agents: string[]; rules: string[] }[] => {
  const result: { agents: string[]; rules: string[] }[] = []

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const [key, ...rest] = line.split(':')
    const value = rest.join(':').trim()

    if (key === 'User-agent') {
      const last = result.at(-1)
      if (last && last.rules.length === 0) last.agents.push(value)
      else result.push({ agents: [value], rules: [] })
    } else {
      result.at(-1)?.rules.push(line)
    }
  }

  return result
}

describe('robotsTxt @S-124', () => {
  it('lets every crawler read the public site and blocks the private areas', () => {
    const text = robotsTxt({ sitemapUrl: SITEMAP })
    const wildcard = groups(text).find((group) => group.agents.includes('*'))

    expect(wildcard).toBeDefined()
    for (const path of ['/admin', '/account', '/api']) {
      expect(wildcard?.rules).toContain(`Disallow: ${path}`)
    }
    expect(wildcard?.rules).not.toContain('Disallow: /')
  })

  it('points at the sitemap from the wildcard group and from the AI group', () => {
    expect(groups(robotsTxt({ sitemapUrl: SITEMAP })).map((group) => group.rules)).toEqual([
      expect.arrayContaining([`Sitemap: ${SITEMAP}`]),
      expect.arrayContaining([`Sitemap: ${SITEMAP}`]),
    ])
  })

  it('leaves the sitemap line out when the site has no canonical origin', () => {
    expect(robotsTxt({})).not.toContain('Sitemap:')
  })

  it('blocks the whole site on a preview, including the sitemap', () => {
    expect(robotsTxt({ crawlable: false, sitemapUrl: SITEMAP })).toBe('User-agent: *\nDisallow: /\n')
  })

  it('allows AI crawlers by default, since vwok has no switch until PJ-104', () => {
    const ai = groups(robotsTxt({ sitemapUrl: SITEMAP })).find((group) => group.agents.includes('GPTBot'))

    expect(ai?.agents).toEqual([...AI_CRAWLERS])
    expect(ai?.rules).toContain('Disallow: /admin')
    expect(ai?.rules).not.toContain('Disallow: /')
  })

  it('turns AI crawlers away when the tenant says so, without touching the rest', () => {
    const parsed = groups(robotsTxt({ allowAiCrawlers: false, sitemapUrl: SITEMAP }))
    const wildcard = parsed.find((group) => group.agents.includes('*'))
    const ai = parsed.find((group) => group.agents.includes('GPTBot'))

    expect(wildcard?.rules).toContain('Disallow: /admin')
    expect(ai?.rules).toEqual(['Disallow: /'])
  })

  it('names the crawlers the switch covers, not a wildcard that cannot be turned off', () => {
    expect(AI_CRAWLERS).toContain('GPTBot')
    expect(AI_CRAWLERS).toContain('ClaudeBot')
    expect(AI_CRAWLERS).toContain('Google-Extended')
    expect(AI_CRAWLERS).not.toContain('*')
  })

  it('keeps the private paths a list of paths, so a site can extend it', () => {
    for (const path of PRIVATE_ROBOTS_PATHS) expect(path.startsWith('/')).toBe(true)
  })
})
