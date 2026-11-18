export type Result =
  | 'ok'
  | 'redirect-ok'
  | 'redirect-wrong'
  | 'redirect-broken'
  | 'redirect-offsite'
  | 'redirect-unmapped'
  | 'title-mismatch'
  | 'not-found'
  | 'other'

export type RedirectMap = Map<string, string>

export interface Check {
  path: string
  status: number
  location: string
  expected: string
  result: Result
  /** Final URL status after following redirects ('' when not applicable). */
  finalStatus: number | ''
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * Parse a sitemap or sitemap index. Throws a clear error if the document's root element is not
 * `<urlset>` or `<sitemapindex>` (e.g. an HTML error page) or if it lists no `<loc>` at all.
 * Child sitemaps are `<sitemap>` entries, pages are `<url>` entries.
 */
export function parseSitemap(xml: string): { kind: 'index' | 'urlset'; locs: string[] } {
  const body = xml
    .replace(/^\uFEFF/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trimStart()
  const root = /^<(?:[\w.-]+:)?(urlset|sitemapindex)(?=[\s>/])/i.exec(body)
  if (!root) {
    const seen = body.slice(0, 60).replace(/\s+/g, ' ')
    throw new Error(`not a sitemap: root element must be <urlset> or <sitemapindex> (document starts "${seen}")`)
  }
  const kind = root[1]!.toLowerCase() === 'sitemapindex' ? 'index' : 'urlset'
  const rootPrefix = /^<(?:([\w.-]+):)?/.exec(body)?.[1] ?? ''
  const locs: string[] = []
  // Entries and <loc> are matched by local name, so `<ns:url><ns:loc>` works. Elements from other
  // namespaces nested in an entry (e.g. `<image:image><image:loc>`) are dropped first: they are not pages.
  const entryRe = /<(?:[\w.-]+:)?(?:url|sitemap)(?=[\s>])[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?(?:url|sitemap)>/gi
  for (const entry of body.matchAll(entryRe)) {
    const own = entry[1]!.replace(
      /<([\w.-]+):[\w.-]+(?=[\s>])[^>]*>[\s\S]*?<\/\1:[\w.-]+>/g,
      (block, prefix: string) => (prefix === rootPrefix ? block : ''),
    )
    const m = /<(?:[\w.-]+:)?loc(?=[\s>])[^>]*>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))\s*<\/(?:[\w.-]+:)?loc>/i.exec(own)
    const loc = m ? (m[1] ?? decodeEntities(m[2] ?? '')).trim() : ''
    if (loc) locs.push(loc)
  }
  if (locs.length === 0) throw new Error(`empty sitemap: <${root[1]}> contains no <loc> entries`)
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
    let parsed: ReturnType<typeof parseSitemap>
    try {
      parsed = parseSitemap(await fetchText(url))
    } catch (e) {
      throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    const { kind, locs } = parsed
    if (kind === 'index') {
      for (const child of locs) await walk(child)
    } else {
      for (const loc of locs) pages.add(loc)
    }
  }
  await walk(sitemapUrl)
  if (pages.size === 0) throw new Error(`${sitemapUrl}: no page URLs found in the sitemap(s)`)
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

/** Failing results. `other` (unverifiable) fails too unless the caller explicitly accepts it. */
export const isFailure = (r: Result): boolean =>
  r === 'other' || r === 'not-found' || r === 'redirect-wrong' || r === 'redirect-broken' || r === 'redirect-offsite' || r === 'title-mismatch'

export function csvEscape(v: string | number): string {
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(checks: Check[]): string {
  const rows = checks.map((c) => [c.path, c.status, c.result, c.location, c.expected, c.finalStatus].map(csvEscape).join(','))
  return ['path,status,result,location,expected,final_status', ...rows].join('\n') + '\n'
}

export function summarize(checks: Check[]): Record<Result, number> {
  const counts: Record<Result, number> = {
    ok: 0,
    'redirect-ok': 0,
    'redirect-wrong': 0,
    'redirect-broken': 0,
    'redirect-offsite': 0,
    'title-mismatch': 0,
    'redirect-unmapped': 0,
    'not-found': 0,
    other: 0,
  }
  for (const c of checks) counts[c.result]++
  return counts
}

const namedEntities: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', raquo: '»', laquo: '«',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', copy: '©',
}

const fromCodePoint = (n: number, fallback: string): string =>
  Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback

/** Decode HTML entities in one pass (so `&amp;lt;` becomes `&lt;`, not `<`). Unknown entities are kept. */
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi, (e, hex?: string, dec?: string, name?: string) =>
    hex ? fromCodePoint(parseInt(hex, 16), e) : dec ? fromCodePoint(Number(dec), e) : (namedEntities[name!.toLowerCase()] ?? e),
  )
}

/** Text of the first `<title>`, entity-decoded with whitespace (incl. NBSP) collapsed; null if absent. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m) return null
  return decodeHtmlEntities(m[1]!).replace(WS, ' ').trim()
}

const WS = /[\s\u00a0\u200b\ufeff]+/g

/** Comparable form of a title: drops the " » Site name" / " | Site name" suffix, case and spacing. */
export function normalizeTitle(title: string): string {
  return title.replace(WS, ' ').replace(/ [»|] [^»|]*$/, '').trim().toLowerCase()
}

export const titlesMatch = (a: string, b: string): boolean => normalizeTitle(a) === normalizeTitle(b)

export interface Fetched {
  status: number
  location: string
  body: string
}

export interface CheckDeps {
  /** Single request, redirects NOT followed. `body` only needs to be filled for 200s. */
  get: (url: string) => Promise<Fetched>
  /** Full legacy URL's HTML title, or null if it can't be fetched/has no title. */
  legacyTitle: () => Promise<string | null>
}

const MAX_HOPS = 5

/**
 * Check one legacy path on the target.
 * - 200: the page <title> must match the legacy page's.
 * - 301/308: must carry a Location; with a map entry it must point there; the redirect chain
 *   is then followed and must end in a 200, otherwise `redirect-broken`.
 */
export async function checkTarget(
  path: string,
  target: string,
  expected: string | undefined,
  deps: CheckDeps,
): Promise<Check> {
  const base = { path, expected: expected ?? '' }
  const first = await deps.get(new URL(path, target).href)
  const result = classify(first.status, first.location, expected, target)
  const out = (r: Result, finalStatus: number | ''): Check => ({
    ...base,
    status: first.status,
    location: first.location,
    result: r,
    finalStatus,
  })

  if (result === 'ok') {
    const [legacy, current] = [await deps.legacyTitle(), extractTitle(first.body)]
    if (legacy === null) return out('other', 200) // cannot verify title: not provably right
    return out(current !== null && titlesMatch(legacy, current) ? 'ok' : 'title-mismatch', 200)
  }
  if (result === 'redirect-ok' || result === 'redirect-unmapped') {
    let hop = first
    let url = new URL(path, target).href
    for (let i = 0; i < MAX_HOPS && (hop.status === 301 || hop.status === 308 || hop.status === 302 || hop.status === 307); i++) {
      if (!hop.location) return out('redirect-broken', hop.status)
      url = new URL(hop.location, url).href
      if (new URL(url).origin !== new URL(target).origin) return out('redirect-offsite', hop.status)
      hop = await deps.get(url)
    }
    return out(hop.status === 200 ? result : 'redirect-broken', hop.status)
  }
  return out(result, '')
}

/** Whether a run should exit 1. */
export function hasFailure(checks: Check[], opts: { allowUnverifiable?: boolean; strict?: boolean }): boolean {
  return checks.some(
    (c) =>
      (isFailure(c.result) && !(opts.allowUnverifiable && c.result === 'other')) ||
      (opts.strict === true && c.result === 'redirect-unmapped'),
  )
}
