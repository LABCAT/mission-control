import type { MysqlConnection } from '../mysql-reader'

// Made-up WordPress rows shaped like a JobRoller site. Names and emails are fake (example.com).
type Row = Record<string, unknown>

export const fixtureTables: Record<string, Row[]> = {
  wp_posts: [
    { ID: 101, post_type: 'job_listing', post_status: 'publish', post_title: 'Front Desk Clerk', post_author: 7, post_date: '2025-03-01 09:00:00' },
    { ID: 102, post_type: 'job_listing', post_status: 'expired', post_title: 'Boat Skipper', post_author: 7, post_date: '2024-11-12 10:30:00' },
    { ID: 103, post_type: 'job_listing', post_status: 'draft', post_title: 'Untitled draft', post_author: 8, post_date: '2025-05-02 08:00:00' },
    { ID: 104, post_type: 'page', post_status: 'publish', post_title: 'About us', post_author: 1, post_date: '2023-01-05 00:00:00' },
    { ID: 105, post_type: 'job_listing', post_status: 'publish', post_title: 'Bookkeeper', post_author: 8, post_date: '2025-06-20 14:15:00' },
    { ID: 106, post_type: 'job_listing', post_status: 'publish', post_title: '', post_author: 8, post_date: '2025-06-21 14:15:00' },
  ],
  wp_postmeta: [
    { meta_id: 1, post_id: 101, meta_key: '_Company', meta_value: 'Example Resort Ltd' },
    { meta_id: 2, post_id: 101, meta_key: '_jr_featured-listings', meta_value: '1' },
    { meta_id: 3, post_id: 102, meta_key: '_Company', meta_value: 'Sample Charters' },
    { meta_id: 4, post_id: 105, meta_key: '_Company', meta_value: 'Test Accounting' },
    { meta_id: 5, post_id: 105, meta_key: '_xero_invoice_id', meta_value: 'inv-0001' },
  ],
  wp_terms: [
    { term_id: 1, name: 'Full-time', slug: 'full-time' },
    { term_id: 2, name: 'Part-time', slug: 'part-time' },
    { term_id: 3, name: 'Voluntary', slug: 'voluntary' },
  ],
}

/**
 * Taxonomies and job locations as a JobRoller site keeps them. Terms live in `wp_terms`, their
 * taxonomy and parent in `wp_term_taxonomy`, and job locations are post meta, not terms.
 */
export const taxonomyTables: Record<string, Row[]> = {
  wp_posts: [
    { ID: 301, post_type: 'job_listing', post_status: 'publish', post_title: 'Front Desk Clerk' },
    { ID: 302, post_type: 'job_listing', post_status: 'publish', post_title: 'Boat Skipper' },
    { ID: 303, post_type: 'job_listing', post_status: 'expired', post_title: 'Past role' },
    { ID: 304, post_type: 'job_listing', post_status: 'publish', post_title: 'Campus Lecturer' },
  ],
  wp_postmeta: [
    { meta_id: 1, post_id: 301, meta_key: '_jr_geo_short_address', meta_value: 'Port Vila, Efate' },
    { meta_id: 2, post_id: 302, meta_key: '_jr_geo_short_address', meta_value: 'Luganville, Espiritu Santo' },
    { meta_id: 3, post_id: 303, meta_key: '_jr_geo_short_address', meta_value: 'Nowhere, Atlantis' },
    // Santo is the legacy name the site's own search placeholder uses for Espiritu Santo.
    { meta_id: 4, post_id: 304, meta_key: '_jr_geo_address', meta_value: 'Main Street, Santo' },
    { meta_id: 5, post_id: 301, meta_key: '_Company', meta_value: 'Example Resort Ltd' },
  ],
  wp_terms: [
    { term_id: 11, name: 'Hospitality &amp; Tourism', slug: 'hospitality-tourism' },
    { term_id: 12, name: 'Construction &amp; roading', slug: 'construction-roading' },
    { term_id: 13, name: '!!!', slug: '!!!' },
    { term_id: 21, name: 'Full-Time', slug: 'full-time' },
    { term_id: 22, name: 'Voluntary', slug: 'voluntary' },
    { term_id: 23, name: 'Board position', slug: 'board-position' },
    { term_id: 24, name: 'Internship', slug: 'internship-voluntary' },
    { term_id: 25, name: 'Not Stated', slug: 'not-stated' },
    { term_id: 31, name: 'Accommodation', slug: 'accommodation' },
    { term_id: 41, name: 'Vt 0 &#8211; 1,000,000', slug: '0-100000' },
    { term_id: 51, name: 'Health', slug: 'health' },
    // Two legacy slugs that differ only in punctuation: both sanitise to `trades-services`.
    { term_id: 32, name: 'Trades & Services', slug: 'trades-services' },
    { term_id: 33, name: 'Trades and services', slug: 'trades_&_services' },
  ],
  wp_term_taxonomy: [
    { term_taxonomy_id: 101, term_id: 11, taxonomy: 'job_cat', parent: 0, count: 4 },
    { term_taxonomy_id: 102, term_id: 12, taxonomy: 'job_cat', parent: 0, count: 2 },
    { term_taxonomy_id: 103, term_id: 13, taxonomy: 'job_cat', parent: 0, count: 1 },
    { term_taxonomy_id: 201, term_id: 21, taxonomy: 'job_type', parent: 0, count: 9 },
    { term_taxonomy_id: 202, term_id: 22, taxonomy: 'job_type', parent: 0, count: 5 },
    // Children of Voluntary: volunteer jobs by AUDIT.md.
    { term_taxonomy_id: 203, term_id: 23, taxonomy: 'job_type', parent: 22, count: 1 },
    { term_taxonomy_id: 204, term_id: 24, taxonomy: 'job_type', parent: 22, count: 1 },
    { term_taxonomy_id: 205, term_id: 25, taxonomy: 'job_type', parent: 0, count: 3 },
    { term_taxonomy_id: 301, term_id: 31, taxonomy: 'job_tag', parent: 0, count: 7 },
    { term_taxonomy_id: 401, term_id: 41, taxonomy: 'job_salary', parent: 0, count: 6 },
    { term_taxonomy_id: 501, term_id: 51, taxonomy: 'area-of-focus', parent: 0, count: 2 },
    { term_taxonomy_id: 502, term_id: 32, taxonomy: 'job_tag', parent: 0, count: 1 },
    { term_taxonomy_id: 503, term_id: 33, taxonomy: 'job_tag', parent: 0, count: 1 },
    // A stray term of another taxonomy, which the importers must ignore.
    { term_taxonomy_id: 601, term_id: 31, taxonomy: 'category', parent: 0, count: 12 },
    // A term_taxonomy row whose term row is gone.
    { term_taxonomy_id: 701, term_id: 999, taxonomy: 'job_cat', parent: 0, count: 0 },
  ],
}

/**
 * The locations a tenant tree would hold for these fixtures, in the shape `seedVanuatuLocations`
 * writes: islands at the root with their picker towns under them, and the picker's catch-alls
 * (`Overseas`, `Other`) as region roots.
 */
export const locationDocs = [
  { id: 1, kind: 'island', name: 'Efate', parent: null, slug: 'efate' },
  { id: 2, kind: 'town', name: 'Port Vila', parent: { id: 1, name: 'Efate', slug: 'efate' }, slug: 'port-vila' },
  { id: 3, kind: 'island', name: 'Espiritu Santo', parent: null, slug: 'espiritu-santo' },
  { id: 4, kind: 'town', name: 'Luganville', parent: { id: 3, name: 'Espiritu Santo', slug: 'espiritu-santo' }, slug: 'luganville' },
  { id: 5, kind: 'town', name: 'White Sands', parent: { id: 9, name: 'Tanna', slug: 'tanna' }, slug: 'white-sands' },
  { id: 6, kind: 'region', name: 'Overseas', parent: null, slug: 'overseas' },
  { id: 7, kind: 'region', name: 'Other', parent: null, slug: 'other' },
  { id: 8, kind: 'town', name: 'Anywhere/Work From Home', parent: { id: 7, name: 'Other', slug: 'other' }, slug: 'anywhere-work-from-home' },
  { id: 9, kind: 'island', name: 'Tanna', parent: null, slug: 'tanna' },
]

/**
 * A fake mysql2 connection over `fixtureTables`. It understands only the SELECT shapes the
 * reader produces: `WHERE` conditions joined by AND (`col = ?`, `col IN (?, ?)`, `col > ?`,
 * with optional parentheses), `ORDER BY col ASC` and `LIMIT n`.
 */
export const createFixtureConnection = (
  tables: Record<string, Row[]> = fixtureTables,
): MysqlConnection & { queries: string[] } => {
  const queries: string[] = []

  return {
    queries,
    async end() {},
    async query(sql, params = []) {
      queries.push(sql)
      if (sql.startsWith('SET ')) return [{}]

      const match = /^SELECT \* FROM `(\w+)` WHERE (.*?)(?: ORDER BY `(\w+)` ASC)?(?: LIMIT (\d+))?$/s.exec(
        sql.trim(),
      )
      if (!match) throw new Error(`Fixture connection cannot parse: ${sql}`)
      const [, table, where = '', orderKey, limit] = match
      const source = tables[table!]
      if (!source) throw new Error(`Unknown fixture table ${table}`)

      let next = 0
      const tests = where
        .replaceAll(/[()]/g, ' ')
        .split(/\s+AND\s+/i)
        .map((part) => part.trim())
        .filter((part) => part && part !== '1 = 1')
        .map((part) => {
          const condition = /^`?(\w+)`?\s*(=|>|IN)\s*(\?|\(?[\s?,]+\)?)$/i.exec(part)
          if (!condition) throw new Error(`Fixture connection cannot parse condition: ${part}`)
          const [, column, operator, placeholders] = condition
          const count = (placeholders!.match(/\?/g) ?? []).length
          const values = params.slice(next, next + count)
          next += count
          return (row: Row) => {
            const value = row[column!] as never
            if (operator === '=') return value === values[0]
            if (operator === '>') return value > (values[0] as never)
            return values.includes(value)
          }
        })

      let rows = source.filter((row) => tests.every((test) => test(row)))
      if (orderKey) rows = [...rows].sort((a, b) => (a[orderKey] as number) - (b[orderKey] as number))
      if (limit) rows = rows.slice(0, Number(limit))
      return [rows.map((row) => ({ ...row }))]
    },
  }
}

const caps = (...roles: string[]): string =>
  `a:${roles.length}:{${roles.map((role) => `s:${role.length}:"${role}";b:1;`).join('')}}`

let metaId = 0
const meta = (user_id: number, meta_key: string, meta_value: string): Row => ({
  meta_key,
  meta_value,
  umeta_id: ++metaId,
  user_id,
})

/**
 * Made-up legacy users (PJ-62). "Today" in the tests is 2026-11-20, so the three-year login
 * boundary is 2023-11-20 00:00:00 and the job/order cut-off is 2022-01-01.
 */
export const userTables: Record<string, Row[]> = {
  wp_users: [
    { ID: 1, display_name: 'Site Admin', user_email: 'admin@example.com', user_pass: '$P$Badmin', user_url: '' },
    { ID: 2, display_name: 'Pat Lister', user_email: 'Pat@Example.com', user_pass: '$P$Bpat', user_url: 'example-resort.test' },
    { ID: 3, display_name: 'Sam Second', user_email: 'sam@example.com', user_pass: '$P$Bsam', user_url: '' },
    { ID: 4, display_name: 'Old Lister', user_email: 'old@example.com', user_pass: '$P$Bold', user_url: '' },
    { ID: 5, display_name: 'Seeker One', user_email: 'seeker1@example.com', user_pass: '$P$Bs1', user_url: '' },
    { ID: 6, display_name: 'Charter Owner', user_email: 'charter@example.com', user_pass: '$P$Bch', user_url: '' },
    { ID: 7, display_name: 'Alert Seeker', user_email: 'alert@example.com', user_pass: '$P$Bal', user_url: '' },
    { ID: 8, display_name: 'Boundary In', user_email: 'in@example.com', user_pass: '$P$Bin', user_url: '' },
    { ID: 9, display_name: 'Boundary Out', user_email: 'out@example.com', user_pass: '$P$Bout', user_url: '' },
    { ID: 10, display_name: '', user_email: 'noname@example.com', user_pass: '$P$Bnn', user_url: '' },
    { ID: 11, display_name: 'Subscriber', user_email: 'sub@example.com', user_pass: '$P$Bsub', user_url: '' },
    { ID: 12, display_name: 'Bad Email', user_email: 'not-an-email', user_pass: '$P$Bbad', user_url: '' },
    { ID: 13, display_name: 'Recruiter', user_email: 'recruit@example.com', user_pass: '$P$Brec', user_url: '' },
  ],
  wp_usermeta: [
    meta(1, 'wp_capabilities', caps('administrator')),
    meta(2, 'wp_capabilities', caps('job_lister')),
    meta(2, 'last_login', '2026-01-10 08:00:00'),
    meta(2, 'nickname', 'Example Resort Ltd'),
    meta(2, 'organisation_type', 'Business'),
    meta(2, 'organisation_size', '11-50'),
    meta(2, 'description', '<p>Beach &amp; bungalows</p>'),
    meta(2, 'area_code', '678'),
    meta(2, 'phone_number', '555 0100'),
    meta(2, 'twitter_id', 'https://x.com/example'),
    meta(2, 'enable_organisations_page', '1'),
    meta(2, 'listing_request', '1'),
    // A present row with an empty value is trusted: query 24 shows all 79 with a blank value.
    meta(2, 'can_pay_by_bank_transfer', ''),
    meta(2, 'can_pay_by_bank_transfer_billing_email', 'Billing@Example.com'),
    meta(2, 'xero_contact_code', 'XC-100'),
    meta(2, 'first_name', 'Pat'),
    meta(2, 'last_name', 'Lister'),
    meta(2, 'wp_user_level', '0'),
    meta(3, 'wp_capabilities', caps('job_lister', 'upload_files')),
    meta(3, 'last_login', '2025-06-01 12:00:00'),
    meta(3, 'nickname', 'example  resort ltd.'),
    meta(3, 'phone_number', '555 0199'),
    meta(4, 'wp_capabilities', caps('job_lister')),
    meta(4, 'last_login', '2019-05-05 00:00:00'),
    meta(4, 'nickname', 'Long Gone Co'),
    meta(5, 'wp_capabilities', caps('job_seeker')),
    meta(5, 'last_login', '2026-02-02 10:00:00'),
    meta(5, 'confirmation_key', 'abc123'),
    meta(6, 'wp_capabilities', caps('job_lister')),
    meta(6, 'nickname', 'Sample Charters'),
    meta(6, 'organisation_size', '1'),
    meta(7, 'wp_capabilities', caps('job_seeker')),
    meta(7, 'jr_alert_status', 'active'),
    meta(7, 'confirmation_key', 'def456'),
    meta(8, 'wp_capabilities', caps('job_lister')),
    meta(8, 'last_login', '2023-11-20 00:00:00'),
    meta(8, 'nickname', 'Boundary Co'),
    meta(9, 'wp_capabilities', caps('job_lister')),
    meta(9, 'last_login', '2023-11-19 23:59:59'),
    meta(9, 'nickname', 'Boundary Out Co'),
    meta(10, 'wp_capabilities', caps('job_lister')),
    meta(10, 'last_login', '2026-03-03 00:00:00'),
    meta(11, 'wp_capabilities', caps('subscriber')),
    meta(11, 'last_login', '2026-03-03 00:00:00'),
    meta(12, 'wp_capabilities', caps('job_lister')),
    meta(12, 'last_login', '2026-03-03 00:00:00'),
    meta(12, 'nickname', 'Bad Email Co'),
    meta(13, 'wp_capabilities', caps('recruiter')),
    meta(13, 'last_login', '2026-03-03 00:00:00'),
    meta(13, 'nickname', 'Pacific Staffing'),
    // Never read: applications, CVs and addresses are out of scope.
    meta(2, 'user_IP', '203.0.113.9'),
    meta(2, 'career_status', 'seeking'),
  ],
  wp_posts: [
    { ID: 901, post_type: 'job_listing', post_status: 'publish', post_author: 6, post_date: '2022-03-01 10:00:00' },
    { ID: 902, post_type: 'transaction', post_status: 'tr_pending', post_author: 9, post_date: '2021-12-31 23:59:59' },
    { ID: 903, post_type: 'job_listing', post_status: 'expired', post_author: 4, post_date: '2021-05-01 00:00:00' },
    { ID: 904, post_type: 'page', post_status: 'publish', post_author: 4, post_date: '2025-05-01 00:00:00' },
  ],
}
