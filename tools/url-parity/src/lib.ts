export type Result = 'ok' | 'redirect-ok' | 'redirect-wrong' | 'redirect-unmapped' | 'not-found' | 'other'

export type RedirectMap = Map<string, string>

export interface Check {
  path: string
  status: number
  location: string
  expected: string
  result: Result
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/** Parse a sitemap or sitemap index. Child sitemaps are `<sitemap>` entries, pages are `<url>` entries. */
export function parseSitemap(xml: string): { kind: 'index' | 'urlset'; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset'
  const locs: string[] = []
  for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/loc>/gi)) {
    const loc = (m[1] ?? decodeEntities(m[2] ?? '')).trim()
    if (loc) locs.push(loc)
  }
  return { kind, locs }
}

/** Walk a sitemap (following indexes) and return unique page URLs in first-seen order. */
export async function collectUrls(
  sitemapUrl: string,
  fetchText: (url: string) => Promise<string>,
): Promise<string[]> {
  const seenSitemaps = new Set<string>()
  const pages = new Set<string>()
  const walk = async (url: string): Promise<void> => {
    if (seenSitemaps.has(url)) return
    seenSitemaps.add(url)
    const { kind, locs } = parseSitemap(await fetchText(url))
    if (kind === 'index') {
      for (const child of locs) await walk(child)
    } else {
      for (const loc of locs) pages.add(loc)
    }
  }
  await walk(sitemapUrl)
  return [...pages]
}

/** Normalise percent-escape case (`%EF` vs `%ef`) so equal URLs compare equal. */
const normEscapes = (s: string): string => s.replace(/%[0-9a-f]{2}/gi, (e) => e.toUpperCase())

/** Path + query of a URL (or of an already-relative path). */
export function toPath(url: string): string {
  const u = new URL(url, 'http://placeholder.invalid')
  return normEscapes(u.pathname + u.search)
}

/** Unique legacy paths from sitemap URLs (duplicates across sitemaps collapse). */
export function uniquePaths(urls: string[]): string[] {
  return [...new Set(urls.map(toPath))]
}

/** Build a redirect map from JSON `{ "/old/": "/new/" }`. Keys and values may be paths or full URLs. */
export function parseRedirectMap(json: string): RedirectMap {
  const raw: unknown = JSON.parse(json)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('redirect map must be a JSON object of { "/old": "/new" }')
  }
  const map: RedirectMap = new Map()
  for (const [from, to] of Object.entries(raw)) {
    if (typeof to !== 'string') throw new Error(`redirect map value for ${from} must be a string`)
    map.set(toPath(from), toPath(to))
  }
  return map
}

/**
 * Classify one response. `location` is the raw Location header ('' if none).
 * 301/308 are permanent redirects; other 3xx are "other" (temporary redirects are not SEO-safe).
 * A permanent redirect with no map entry is `redirect-unmapped`: reported, but not provably right.
 */
export function classify(
  status: number,
  location: string,
  expected: string | undefined,
  targetBase: string,
): Result {
  if (status === 200) return 'ok'
  if (status === 404 || status === 410) return 'not-found'
  if (status === 301 || status === 308) {
    if (expected === undefined) return 'redirect-unmapped'
    if (!location) return 'redirect-wrong'
    const dest = new URL(location, targetBase)
    const sameOrigin = dest.origin === new URL(targetBase).origin
    return sameOrigin && toPath(dest.href) === expected ? 'redirect-ok' : 'redirect-wrong'
  }
  return 'other'
}

export const isFailure = (r: Result): boolean => r === 'not-found' || r === 'redirect-wrong'

export function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(checks: Check[]): string {
  const rows = checks.map((c) => [c.path, c.status, c.result, c.location, c.expected].map(csvEscape).join(','))
  return ['path,status,result,location,expected', ...rows].join('\n') + '\n'
}

export function summarize(checks: Check[]): Record<Result, number> {
  const counts: Record<Result, number> = {
    ok: 0,
    'redirect-ok': 0,
    'redirect-wrong': 0,
    'redirect-unmapped': 0,
    'not-found': 0,
    other: 0,
  }
  for (const c of checks) counts[c.result]++
  return counts
}
