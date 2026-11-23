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

/**
 * Legacy jobs (PJ-64) on top of the PJ-62 users. "Today" in the tests is 2026-11-20.
 * 1001 published, matches an imported organisation; 1002 expired for a client that has no
 * organisation; 1003 draft and 1004 trash (not imported); 1005 has no company, so its author's
 * organisation is used; 1006 has neither (skipped); 1007 clashes with a category slug and has
 * malicious markup; 1008 uses the broken salary term, `Independant`, and several locations.
 */
export const jobTables: Record<string, Row[]> = (() => {
  const post = (ID: number, post_status: string, extra: Row = {}): Row => ({
    ID,
    post_author: 1,
    post_content: '',
    post_date: '2026-11-01 09:00:00',
    post_date_gmt: '2026-10-31 22:00:00',
    post_modified: '2026-11-01 09:00:00',
    post_modified_gmt: '2026-10-31 22:00:00',
    post_name: `job-${ID}`,
    post_status,
    post_title: `Job ${ID}`,
    post_type: 'job_listing',
    ...extra,
  })
  let id = 5000
  const pm = (post_id: number, meta_key: string, meta_value: string): Row => ({ meta_id: ++id, meta_key, meta_value, post_id })
  const rel = (object_id: number, term_taxonomy_id: number): Row => ({ object_id, term_taxonomy_id })

  return {
    wp_posts: [
      ...(userTables.wp_posts ?? []),
      post(1001, 'publish', {
        post_content: '<p>Greet <strong>guests</strong> &amp; <em>answer</em> the phone.</p><ul><li>Roster</li><li>Tidy</li></ul>',
        post_name: 'front-desk-clerk',
        post_title: 'Front Desk Clerk',
      }),
      post(1002, 'expired', {
        post_date: '2025-01-10 09:00:00',
        post_date_gmt: '2025-01-09 22:00:00',
        post_modified: '2025-01-20 09:00:00',
        post_modified_gmt: '2025-01-19 22:00:00',
        post_name: 'boat-skipper',
        post_title: 'Boat Skipper',
      }),
      post(1003, 'draft'),
      post(1004, 'trash'),
      post(1005, 'publish', { post_author: 6, post_name: 'deckhand' }),
      post(1006, 'publish'),
      post(1007, 'publish', {
        post_content: '<p>Hi<script>alert(1)</script><a href="javascript:alert(2)">click</a></p><img src=x onerror=alert(3)>',
        post_name: 'hospitality-tourism',
      }),
      post(1008, 'publish', { post_name: 'cook' }),
    ],
    wp_postmeta: [
      ...(userTables.wp_postmeta ?? []),
      pm(1001, '_Company', 'Example Resort Ltd'),
      pm(1001, '_CompanyURL', 'example-resort.test'),
      pm(1001, '_how_to_apply', 'Email us <b>now</b>\r\nor call'),
      pm(1001, '_jr_job_duration', '30'),
      pm(1001, '_jr_fx_expire_days', '14'),
      pm(1001, 'jr_fx_apps_recipient_address', 'Jobs@Example.com'),
      pm(1001, 'jr_fx_disable_apply_online', '1'),
      pm(1001, '_displayed_salary', 'VT 100,000 &#8211; 120,000 a month'),
      pm(1001, '_jr_featured-listings', '1'),
      pm(1001, '_jr_featured-listings_start_date', '2026-11-01'),
      pm(1001, '_jr_featured-listings_duration', '30'),
      pm(1001, '_jr_featured-cat', '1'),
      pm(1001, '_jr_address', 'Port Vila, Efate'),
      pm(1001, 'jr_total_count', '120'),
      pm(1001, 'user_IP', '203.0.113.9'),
      pm(1002, '_Company', 'Client Agency Co'),
      pm(1002, '_jr_job_duration', '45'),
      pm(1002, '_jr_expired_reason', 'user_ended'),
      pm(1002, '_jr_featured-listings', '1'),
      pm(1002, '_jr_address', 'Luganville - SANTO'),
      pm(1002, 'jr_total_count', '7'),
      pm(1005, '_jr_address', 'Nowhere, Atlantis'),
      pm(1006, '_Company', ''),
      pm(1007, '_Company', 'Client Agency Co'),
      pm(1007, '_jr_address', 'Efate, Santo and Tanna'),
      pm(1008, '_Company', 'Sample Charters'),
      pm(1008, '_jr_address', 'Efate,Port Vila'),
    ],
    wp_terms: [
      { term_id: 11, name: 'Hospitality &amp; Tourism', slug: 'hospitality-tourism' },
      { term_id: 12, name: 'Construction &amp; roading', slug: 'construction-roading' },
      { term_id: 21, name: 'Full-Time', slug: 'full-time' },
      { term_id: 26, name: 'Independant', slug: 'independant' },
      { term_id: 27, name: 'Independent', slug: 'independent' },
      { term_id: 41, name: '0 - 1,000,000', slug: '0-100000' },
      { term_id: 42, name: '000', slug: '000' },
      { term_id: 43, name: '1,000,000-1,500,000', slug: '1000000-1500000' },
      { term_id: 44, name: '1,000,000-2,000,000', slug: '1000000-2000000' },
    ],
    wp_term_taxonomy: [
      { term_taxonomy_id: 101, term_id: 11, taxonomy: 'job_cat', parent: 0 },
      { term_taxonomy_id: 102, term_id: 12, taxonomy: 'job_cat', parent: 0 },
      { term_taxonomy_id: 201, term_id: 21, taxonomy: 'job_type', parent: 0 },
      { term_taxonomy_id: 202, term_id: 26, taxonomy: 'job_type', parent: 0 },
      { term_taxonomy_id: 203, term_id: 27, taxonomy: 'job_type', parent: 0 },
      { term_taxonomy_id: 401, term_id: 41, taxonomy: 'job_salary', parent: 0 },
      { term_taxonomy_id: 402, term_id: 42, taxonomy: 'job_salary', parent: 0 },
      { term_taxonomy_id: 403, term_id: 43, taxonomy: 'job_salary', parent: 0 },
      { term_taxonomy_id: 404, term_id: 44, taxonomy: 'job_salary', parent: 0 },
    ],
    wp_term_relationships: [
      rel(1001, 201), rel(1001, 101), rel(1001, 102), rel(1001, 401),
      rel(1002, 201),
      rel(1005, 201),
      rel(1007, 101),
      rel(1008, 202), rel(1008, 402), rel(1008, 403),
    ],
    wp_users: userTables.wp_users ?? [],
    wp_usermeta: userTables.wp_usermeta ?? [],
  }
})()

/**
 * Pages, menus and site chrome as a JobRoller site keeps them (PJ-67). The published pages are
 * the ones the site linked; the rest are WordPress machinery the new site serves from routes.
 */
export const pageTables: Record<string, Row[]> = {
  wp_options: [
    { option_id: 1, option_name: 'blogname', option_value: 'Vanuatu Wok' },
    { option_id: 2, option_name: 'blogdescription', option_value: 'Jobs in Vanuatu' },
    { option_id: 3, option_name: 'WPLANG', option_value: 'en_VU' },
    { option_id: 4, option_name: 'jr_enable_header_banner', option_value: '1' },
    {
      option_id: 5,
      option_name: 'jr_header_banner',
      option_value:
        '<a href="https://ycv.vu"><img alt="Powered by YCV" src="https://vanuatuwok.vu/app/uploads/2021/11/header.png"></a>',
    },
    {
      option_id: 6,
      option_name: 'jr_listing_banner',
      option_value:
        '<a href="https://ycv.vu"><img src="https://vanuatuwok.vu/app/uploads/2021/11/header-320x50.png"></a>',
    },
    {
      option_id: 7,
      option_name: 'jr_logo_url',
      option_value: 'https://vanuatuwok.vu/app/uploads/2020/05/cropped-logo.png',
    },
  ],
  wp_terms: [
    { term_id: 71, name: 'Main menu', slug: 'main-menu' },
    { term_id: 72, name: 'Top menu', slug: 'top-menu' },
    { term_id: 73, name: 'Bottom menu', slug: 'bottom-menu' },
  ],
  wp_term_taxonomy: [
    { term_taxonomy_id: 701, term_id: 71, taxonomy: 'nav_menu', parent: 0, count: 5 },
    { term_taxonomy_id: 702, term_id: 72, taxonomy: 'nav_menu', parent: 0, count: 1 },
    { term_taxonomy_id: 703, term_id: 73, taxonomy: 'nav_menu', parent: 0, count: 3 },
  ],
  wp_term_relationships: [
    // Main: Jobs (custom /jobs), Volunteering, For Employers, Organisations, About us.
    { object_id: 801, term_taxonomy_id: 701 },
    { object_id: 802, term_taxonomy_id: 701 },
    { object_id: 803, term_taxonomy_id: 701 },
    { object_id: 804, term_taxonomy_id: 701 },
    { object_id: 805, term_taxonomy_id: 701 },
    // Top: Contact us.
    { object_id: 806, term_taxonomy_id: 702 },
    // Bottom: YCV link, Password Reset (a WP-only page), Submit Job.
    { object_id: 807, term_taxonomy_id: 703 },
    { object_id: 808, term_taxonomy_id: 703 },
    { object_id: 809, term_taxonomy_id: 703 },
  ],
  wp_posts: [
    { ID: 61, post_type: 'page', post_status: 'publish', post_name: 'volunteer-jobs', post_title: 'Volunteering', post_content: '<p>Volunteer with us.</p>' },
    { ID: 38, post_type: 'page', post_status: 'publish', post_name: 'employers', post_title: 'For Employers', post_content: '<p>Post a job.</p>' },
    { ID: 23445, post_type: 'page', post_status: 'publish', post_name: 'organisations', post_title: 'Organisations', post_content: '<p>Our members.</p>' },
    { ID: 3983, post_type: 'page', post_status: 'publish', post_name: 'about-us', post_title: 'About us', post_content: '<p>About YCV.</p>' },
    { ID: 655, post_type: 'page', post_status: 'publish', post_name: 'contact', post_title: 'Contact us', post_content: '<p>Contact us.</p>' },
    { ID: 29301, post_type: 'page', post_status: 'publish', post_name: 'contact-2', post_title: 'Contact', post_content: '<p>Get in touch.</p>[contact-form][/contact-form]' },
    { ID: 1366, post_type: 'page', post_status: 'publish', post_name: 'home', post_title: 'Home', post_content: '<p>Welcome to Vanuatu Wok.</p>' },
    { ID: 33579, post_type: 'page', post_status: 'publish', post_name: 'land-law-reforms', post_title: 'LAND LAW REFORMS', post_content: '<p>Land law.</p>' },
    { ID: 29143, post_type: 'page', post_status: 'publish', post_name: 'organisation-competition', post_title: 'Organisation Competition', post_content: '<p>Competition.</p>' },
    { ID: 10, post_type: 'page', post_status: 'publish', post_name: 'terms-conditions', post_title: 'Terms &amp; Conditions', post_content: '<p>Terms.</p>' },
    // Machinery: dropped, not imported.
    { ID: 4, post_type: 'page', post_status: 'publish', post_name: 'jobs', post_title: 'Jobs', post_content: '' },
    { ID: 13, post_type: 'page', post_status: 'publish', post_name: 'submit', post_title: 'Submit Job', post_content: '' },
    { ID: 19, post_type: 'page', post_status: 'publish', post_name: 'password-reset', post_title: 'Password Reset', post_content: '' },
    { ID: 36658, post_type: 'page', post_status: 'publish', post_name: 'ycv', post_title: 'Powered by Youth Challenge Vanuatu', post_content: '' },
    // Menu item posts.
    { ID: 801, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'Jobs', menu_order: 1 },
    { ID: 802, post_type: 'nav_menu_item', post_status: 'publish', post_title: '', menu_order: 2 },
    { ID: 803, post_type: 'nav_menu_item', post_status: 'publish', post_title: '', menu_order: 3 },
    { ID: 804, post_type: 'nav_menu_item', post_status: 'publish', post_title: '', menu_order: 4 },
    { ID: 805, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'About us', menu_order: 5 },
    { ID: 806, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'Contact us', menu_order: 1 },
    { ID: 807, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'Powered by Youth Challenge Vanuatu', menu_order: 1 },
    { ID: 808, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'Password Reset', menu_order: 2 },
    { ID: 809, post_type: 'nav_menu_item', post_status: 'publish', post_title: 'Submit Job', menu_order: 3 },
  ],
  wp_postmeta: [
    { meta_id: 901, post_id: 801, meta_key: '_menu_item_type', meta_value: 'custom' },
    { meta_id: 902, post_id: 801, meta_key: '_menu_item_url', meta_value: '/jobs' },
    { meta_id: 903, post_id: 802, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 904, post_id: 802, meta_key: '_menu_item_object_id', meta_value: '61' },
    { meta_id: 905, post_id: 803, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 906, post_id: 803, meta_key: '_menu_item_object_id', meta_value: '38' },
    { meta_id: 907, post_id: 804, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 908, post_id: 804, meta_key: '_menu_item_object_id', meta_value: '23445' },
    { meta_id: 909, post_id: 805, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 910, post_id: 805, meta_key: '_menu_item_object_id', meta_value: '3983' },
    { meta_id: 911, post_id: 806, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 912, post_id: 806, meta_key: '_menu_item_object_id', meta_value: '29301' },
    { meta_id: 913, post_id: 807, meta_key: '_menu_item_type', meta_value: 'custom' },
    { meta_id: 914, post_id: 807, meta_key: '_menu_item_url', meta_value: 'https://www.ycv.vu' },
    { meta_id: 915, post_id: 808, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 916, post_id: 808, meta_key: '_menu_item_object_id', meta_value: '19' },
    { meta_id: 917, post_id: 809, meta_key: '_menu_item_type', meta_value: 'post_type' },
    { meta_id: 918, post_id: 809, meta_key: '_menu_item_object_id', meta_value: '13' },
  ],
}
