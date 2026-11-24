/**
 * The legacy redirect table as data: what `tools/url-parity` needs to check the launch (PJ-42).
 *
 * The rules in `legacy-map.ts` answer one request at a time, which is what the Worker does. A
 * crawler needs the whole table at once, so this turns the rules into a map over the URLs the
 * crawl actually found. Both come from the same rules, so a rule change shows up in both.
 *
 * A redirect goes in `redirects` (path → final URL); a retired page goes in `gone`, because a
 * 410 is an answer but not a destination. A path the rules leave to the app is in neither: it is
 * a live route, not a legacy URL.
 */
import { legacyRedirect, type LegacyRedirectOptions } from './legacy-map'

export type LegacyTable = {
  /** Paths answered 410, sorted. */
  gone: string[]
  /** Path → the URL it is answered with, sorted by path. */
  redirects: Record<string, string>
  /** Paths the app's own routes answer, sorted. */
  routes: string[]
}

/**
 * Build the table for a list of legacy paths. `paths` is the crawler's output: every URL the old
 * site published, as a path (a query string is part of the path only when the rules use it).
 */
export const legacyTable = (
  paths: readonly string[],
  options: LegacyRedirectOptions = {},
): LegacyTable => {
  const gone: string[] = []
  const redirects: Record<string, string> = {}
  const routes: string[] = []

  for (const path of paths) {
    const [pathname, search = ''] = splitPath(path)
    const target = legacyRedirect({ pathname, search }, options)

    if (!target) routes.push(path)
    else if (target.kind === 'gone') gone.push(path)
    else redirects[path] = target.location
  }

  return {
    gone: gone.sort(),
    redirects: Object.fromEntries(Object.entries(redirects).sort(([a], [b]) => a.localeCompare(b))),
    routes: routes.sort(),
  }
}

/** A crawled URL as a path and its query, without a trailing slash on the path. */
export const splitPath = (path: string): [string, string] => {
  const at = path.indexOf('?')
  const pathname = (at === -1 ? path : path.slice(0, at)) || '/'
  const search = at === -1 ? '' : path.slice(at)

  return [pathname !== '/' ? pathname.replace(/\/+$/, '') : '/', search]
}
