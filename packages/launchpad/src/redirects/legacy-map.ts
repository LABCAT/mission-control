/**
 * The legacy WordPress/JobRoller URLs, mapped to the new site (PJ-42).
 *
 * The old permalinks are not the new routes: `/job-category/trades-services/` is
 * `/jobs/trades-services` now, `/organisation/{nickname}/` is `/organisations/{slug}`, and a pile
 * of WordPress machinery has no successor at all. Given a request, this module answers one of
 * three things:
 *
 * - a **301** to the new URL, so a crawler moves the ranking across and a bookmark still lands;
 * - a **410** for what is deliberately gone (the CV module, two retired promo pages), which stops
 *   a crawler asking sooner than a 404 does;
 * - `null`, meaning "not a legacy URL": the app's own router answers it.
 *
 * Every rule is pure, so a test can walk the whole legacy surface without a Worker, a CMS or a
 * network. Targets are final URLs, never another redirect, which is what keeps a chain from
 * forming; the tests assert that by feeding each target back through the table.
 *
 * Legacy shapes come from `docs/Checkpoints/2026-11-08-VanuaTwok-Public-Crawl.md`. The mapping
 * decisions are STATUS.md's 19–20 Nov lines: `/resumes/*` → 410, retired promo pages → 410,
 * `?p=ID` → 301, the old search URLs → the new filter URLs with unknown parameters dropped.
 */
import { legacySlug, organisationSlug } from './slug'

export type LegacyTarget =
  | { kind: 'gone'; status: 410 }
  | { kind: 'redirect'; location: string; status: 301 }

/**
 * Where the new site's filter pages live. The founder's decision (19 Nov) is one clean level,
 * `/jobs/{category}` and `/jobs/{type}`; a site that has not moved yet can pass the theme's
 * `/jobs/category/{slug}` routes instead, so a redirect is retargeted without touching a rule.
 */
export type LegacyRoutePaths = {
  category: (slug: string) => string
  /** A job page. The slug is unchanged (PJ-37), so the default is the flat legacy path. */
  job: (slug: string) => string
  jobs: string
  salary: (slug: string) => string
  type: (slug: string) => string
}

export const defaultLegacyRoutePaths: LegacyRoutePaths = {
  category: (slug) => `/jobs/${encodeURIComponent(slug)}`,
  job: (slug) => `/jobs/${encodeURIComponent(slug)}`,
  jobs: '/jobs',
  salary: (slug) => `/jobs?salary=${encodeURIComponent(slug)}`,
  type: (slug) => `/jobs/${encodeURIComponent(slug)}`,
}

export type LegacyRedirectOptions = {
  /**
   * `?p=ID` → the post's new path, from the crawl's shortlink table. A shortlink is per-post
   * data, not a rule, so the site supplies it. An id that is absent is a post nobody carried
   * over (a CV, a draft), which is gone.
   */
  shortlinks?: ReadonlyMap<number, string>
  /** Exact-path answers a site needs beyond the rules; checked first. */
  table?: ReadonlyMap<string, LegacyTarget>
  /**
   * An attachment page's WordPress attachment id → its file on R2 (PJ-63). An id that is not in
   * the table is a file that was not imported, which is gone (STATUS.md 20 Nov).
   */
  attachments?: ReadonlyMap<number, string>
  /**
   * A legacy upload path (`/app/uploads/2021/05/x.pdf`) → its file on R2. Keyed by the whole
   * legacy path, so the table is the importer's output rather than a second naming scheme. A
   * path that is not in the table is a file that was not imported, which is gone.
   */
  files?: ReadonlyMap<string, string>
  /** Defaults to the founder's clean filter URLs. */
  paths?: LegacyRoutePaths
}

const redirect = (location: string): LegacyTarget => ({ kind: 'redirect', location, status: 301 })
const gone = (): LegacyTarget => ({ kind: 'gone', status: 410 })

/** The job feed routes (PJ-122); a legacy feed URL points at them for when they land. */
export const FEED_JOBS = '/feed/jobs.xml'
export const FEED_VOLUNTARY_JOBS = '/feed/voluntary-jobs.xml'

/**
 * Legacy pages with no successor. `resumes` covers the whole CV module: its listing, every CV
 * profile, the CV taxonomies and the CV feeds. The two promo pages were not carried over, and
 * the founder chose 410 over a redirect that would point at unrelated content.
 */
const GONE_BASES: readonly string[] = [
  'job-email-text',
  'land-law-reforms',
  'no-resumes',
  'organisation-competition',
  'resumes',
]

/** Pages the new site absorbed into its home page. */
const MOVED_BASES: Record<string, string> = {
  blog: '/',
  'home-2': '/',
  'sample-page': '/',
}

/** Legacy account pages → the dashboard, which is `/account/*` now (PJ-81). */
const ACCOUNT_BASES: Record<string, string> = {
  confirm: '/account',
  dashboard: '/account',
  'edit-job': '/account',
  'edit-resume': '/account',
  invoice: '/account',
  'my-profile': '/account',
  'password-recovery': '/account',
  'password-reset': '/account',
  'purchase-job-pack': '/account',
  'purchase-resume-subscription': '/account',
  'resend-confirmation': '/account',
  submit: '/account',
  'xero-auth': '/account',
  login: '/account/login',
  register: '/account/register',
  'sign-up': '/account/register',
}

/**
 * Legacy content pages whose new address is not their old slug. The rule applies to the page and
 * to anything under it, because WordPress served a page's uploaded images as
 * `/about-us/screen-shot-2018-…/`: the page is the nearest equivalent of that URL, and the file
 * itself is covered by the site's file table when the importer carried it over.
 *
 * `contact` is absent on purpose: the Contact system page is seeded at `/contact`, so that path is
 * the live page, not an old one.
 */
const RENAMED_BASES: Record<string, string> = {
  'about-us': '/about',
  'contact-2': '/contact',
  employer: '/employers',
}

/**
 * Legacy pages that kept their new address but gained children in the old site: `/employers/` is a
 * live page, and `/employers/list-job-vacancy-now/` was a subsection of it. A child goes to the
 * page, which is where the content is now.
 *
 * `/organisations/` is absent on purpose: the legacy site's organisation URLs were
 * `/organisation/{nick}/`, and the new site's `/organisations/{slug}` is a live profile route, so
 * a rule here would redirect those profiles onto the directory.
 */
const KEPT_BASES_WITH_CHILDREN: Record<string, string> = {
  employers: '/employers',
}

/** Decode one path segment; a malformed escape is kept as typed, so the lookup simply misses. */
const decodeSegment = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** The path with no query, no empty segments and no trailing slash, plus its segments. */
export const normaliseLegacyPath = (pathname: string): { path: string; segments: string[] } => {
  const segments = (pathname.split(/[?#]/)[0] ?? '/')
    .split('/')
    .filter((part) => part !== '')
    .map(decodeSegment)

  return { path: `/${segments.join('/')}`, segments }
}

const searchParams = (search: null | string | URLSearchParams | undefined): URLSearchParams =>
  typeof search === 'string' ? new URLSearchParams(search) : (search ?? new URLSearchParams())

/** Parameters the legacy archive understood; anything else in the URL is junk and is dropped. */
const LEGACY_SEARCH_PARAMS = ['action', 'jobs_by_date', 'location', 'radius', 's', 'time'] as const

/**
 * True when the query string is one of the old archive's: its own keyword/location names, its
 * `{type}=show` checkboxes, or the job-date-archive switches. Without this a plain `/jobs/` and a
 * `/jobs/?s=chef` would look alike, and the second one must move to a filter URL.
 */
export const isLegacyListingQuery = (query: URLSearchParams): boolean =>
  LEGACY_SEARCH_PARAMS.some((name) => query.has(name)) || [...query.values()].includes('show')

/**
 * A legacy search or filter query as the new listing's query string.
 *
 * `s` was the keyword and is `q` now; `location` was typed by hand and is a taxonomy slug now, so
 * it is slugged; each `{job-type}=show` checkbox becomes the listing's single `type`. The date
 * window (`time`, `jobs_by_date`), `action`, `radius` and unknown parameters name no filter the
 * new listing has, so they are dropped rather than carried along as dead weight.
 */
export const legacyListingQuery = (query: URLSearchParams): string => {
  const next = new URLSearchParams()

  const keyword = query.get('s')?.trim()
  if (keyword) next.set('q', keyword)

  const location = legacySlug(query.get('location') ?? '')
  if (location) next.set('location', location)

  for (const [name, value] of query.entries()) {
    if (value !== 'show' || (LEGACY_SEARCH_PARAMS as readonly string[]).includes(name)) continue
    const type = legacySlug(name)
    if (type) next.set('type', type)
  }

  return next.toString()
}

const listingTarget = (query: URLSearchParams, paths: LegacyRoutePaths): string => {
  const mapped = legacyListingQuery(query)
  return mapped ? `${paths.jobs}?${mapped}` : paths.jobs
}

/** `?p=10` → the post's new path. An id that is not in the table is a post that is gone. */
const shortlinkTarget = (
  query: URLSearchParams,
  shortlinks: ReadonlyMap<number, string> | undefined,
): LegacyTarget | null => {
  const raw = query.get('p')?.trim()
  if (!raw) return null
  if (!/^\d+$/.test(raw)) return gone()

  const location = shortlinks?.get(Number(raw))
  return location ? redirect(location) : gone()
}

/**
 * The answer for one legacy request, or `null` when the path is not a legacy URL.
 *
 * Order matters twice over. A site's own table wins over every rule, so a one-off can be
 * corrected without a code change. `?p=` wins over the path rules, because WordPress resolved a
 * shortlink whatever path it arrived on; an id with no entry is therefore 410 before the path
 * could be read as something else.
 */
export const legacyRedirect = (
  { pathname, search }: { pathname: string; search?: null | string | URLSearchParams },
  { attachments, files, paths = defaultLegacyRoutePaths, shortlinks, table }: LegacyRedirectOptions = {},
): LegacyTarget | null => {
  const { path, segments } = normaliseLegacyPath(pathname)
  const query = searchParams(search)

  const override = table?.get(path)
  if (override) return override

  const shortlink = shortlinkTarget(query, shortlinks)
  if (shortlink) return shortlink

  // A legacy file (an upload such as `/app/uploads/2021/05/x.pdf`, or an attachment page such as
  // `/about-us/img_5612/`) is not a page: when the importer carried it over it redirects to its R2
  // copy. `/app/uploads/` is the WordPress upload directory, so a path in it that is not in the
  // table is a file that was not imported. A non-upload attachment page that is not in the table
  // falls through to its parent's rule, which is a better answer than 410 for a page that moved.
  const file = files?.get(path)
  if (file) return redirect(file)
  if (path.startsWith('/app/uploads/')) return gone()

  const [head, ...rest] = segments
  if (!head) {
    // `/` is the site's own home page; only an old archive query moves.
    return isLegacyListingQuery(query) ? redirect(listingTarget(query, paths)) : null
  }

  // The feed routes are the redirect targets; a request for them is the site's own route, not a
  // legacy URL. Without this the `/feed/*` rule would redirect a feed onto itself forever.
  if (path === FEED_JOBS || path === FEED_VOLUNTARY_JOBS) return null

  if (head === 'wp') {
    // XML-RPC is an endpoint, not a page (it answered 405 to GET); it has no successor.
    return rest.at(-1) === 'xmlrpc.php' ? gone() : redirect('/')
  }

  if (GONE_BASES.includes(head)) return gone()

  const moved = MOVED_BASES[head]
  if (moved) return redirect(moved)

  const account = ACCOUNT_BASES[head]
  if (account) return redirect(account)

  const renamed = RENAMED_BASES[head]
  if (renamed) return redirect(renamed)

  // A child of a page that is itself live (`/employers/list-job-vacancy-now/`) belongs to that
  // page: the old site nested content under it, and the new one keeps it as one document.
  const keptChild = rest.length > 0 ? KEPT_BASES_WITH_CHILDREN[head] : undefined
  if (keptChild) return redirect(keptChild)

  if (head === 'organisation' || head === 'author') {
    const nickname = rest[0]
    if (!nickname) return redirect('/organisations')
    // `/organisation/{nick}/feed/` was that organisation's own job feed; the profile is nearest.
    return redirect(`/organisations/${encodeURIComponent(organisationSlug(nickname))}`)
  }

  // A taxonomy's own feed (`/job-category/x/feed/`) belongs to the taxonomy page, so the trailing
  // `feed` is dropped before the slug is read. Without this the deepest segment would be `feed`.
  const taxonomySegments = rest.at(-1) === 'feed' ? rest.slice(0, -1) : rest

  if (head === 'job-category') {
    const slug = legacySlug(taxonomySegments.at(-1) ?? '')
    return redirect(slug ? paths.category(slug) : paths.jobs)
  }

  if (head === 'job-type') {
    // Legacy job types nested, `/job-type/voluntary/board-position/`; type slugs are unique across
    // categories and locations (PJ-98), so the deepest segment names the page.
    const slug = legacySlug(taxonomySegments.at(-1) ?? '')
    return redirect(slug ? paths.type(slug) : paths.jobs)
  }

  if (head === 'job-salary') {
    const slug = legacySlug(taxonomySegments.at(-1) ?? '')
    return redirect(slug ? paths.salary(slug) : paths.jobs)
  }

  if (head === 'job-date-archive') return redirect(listingTarget(query, paths))

  if (head === 'feed' || head === 'rss-feed') return redirect(FEED_JOBS)

  if (head === 'volunteer-jobs' && rest[0] === 'rss-feed') return redirect(FEED_VOLUNTARY_JOBS)

  if (head === 'jobs') {
    if (rest.length === 0) {
      return isLegacyListingQuery(query) ? redirect(listingTarget(query, paths)) : null
    }
    if (rest[0] === 'feed') return redirect(FEED_JOBS)

    if (rest[0] === 'page') {
      const page = Number(rest[1] ?? '')
      return redirect(Number.isInteger(page) && page > 1 ? `${paths.jobs}?page=${page}` : paths.jobs)
    }

    // An attachment page (`/jobs/{slug}/attachment/{id}/`) is a file, not a page: it redirects to
    // the file on R2 when the importer carried it over, and is gone when it did not (20 Nov).
    if (rest[1] === 'attachment') {
      const file = attachments?.get(Number(rest[2] ?? ''))
      return file ? redirect(file) : gone()
    }

    // Anything else under a job (`/jobs/{slug}/feed/`, `/jobs/{slug}/iiss-logo/`) belongs to the
    // job page, which keeps its slug (PJ-37). Left to the app these would be 404s.
    if (rest.length > 1) return redirect(`${paths.job(rest[0]!)}`)

    // `/jobs/{slug}/` is the job page itself, so the job route answers.
    return null
  }

  return null
}
