/**
 * `/llms.txt` for a site (PJ-104): the plain-text summary an AI agent reads before it browses.
 *
 * The founder's decision (19 Nov) is a file per tenant with a site summary and the key URLs. It
 * is generated from the same data the sitemap is: the tenant, its live jobs, its public
 * organisations and its published pages, so it cannot advertise a URL the site would 404 or ask
 * crawlers to skip.
 *
 * The shape is the one llmstxt.org documents: an `H1` with the site's name, a short blockquote
 * summary, then link lists. Every URL is absolute, because a relative one is useless to an agent
 * that fetched the file on its own.
 */
import type { SiteTenant } from '../tenant/types'

/** One link in the file. `path` is site-relative; the file makes it absolute. */
export type LlmsLink = {
  name: string
  path: string
  /** A few words after the link, in parentheses, when the name needs context. */
  note?: null | string
}

export type LlmsSection = {
  links: readonly LlmsLink[]
  title: string
}

export type LlmsTxtInput = {
  /** The site's own summary. Falls back to a sentence built from the tenant and its job count. */
  description?: null | string
  /** Live jobs, newest first. The section is left out when there are none. */
  jobs?: readonly LlmsLink[]
  /** Public organisations, by name. */
  organisations?: readonly LlmsLink[]
  /** Published, indexable pages besides the home page. */
  pages?: readonly LlmsSection[]
  siteUrl: string
  tenant: SiteTenant
}

/** The listing, the directory and the feed: the addresses an agent needs whatever the content. */
const coreLinks = (): LlmsLink[] => [
  { name: 'Jobs', path: '/jobs', note: 'every live job, with filters' },
  { name: 'Organisations', path: '/organisations', note: 'employers with a public page' },
]

/**
 * The file. Sections with no links are left out rather than printed empty: an agent reading
 * "Organisations" followed by nothing learns less than nothing. A site with no canonical origin
 * cannot build the URLs the file is made of, so the caller answers 404 instead of calling this.
 */
export const llmsTxt = ({
  description,
  jobs = [],
  organisations = [],
  pages = [],
  siteUrl,
  tenant,
}: LlmsTxtInput): string => {
  const origin = siteUrl.trim().replace(/\/+$/, '')
  const url = (path: string): string => `${origin}${path.startsWith('/') ? path : `/${path}`}`
  const link = ({ name, note, path }: LlmsLink): string =>
    `- [${name.trim()}](${url(path)})${note?.trim() ? `: ${note.trim()}` : ''}`

  const summary =
    description?.trim() ||
    `${tenant.name.trim()} lists live jobs and the organisations that post them.`

  const sections: LlmsSection[] = [
    { links: coreLinks(), title: 'Start here' },
    ...pages,
    { links: jobs, title: 'Live jobs' },
    { links: organisations, title: 'Organisations' },
  ]

  const body = sections
    .filter((section) => section.links.length > 0)
    .map((section) => `## ${section.title}\n\n${section.links.map(link).join('\n')}`)
    .join('\n\n')

  return `# ${tenant.name.trim()}\n\n> ${summary}\n\n${body}\n`
}
