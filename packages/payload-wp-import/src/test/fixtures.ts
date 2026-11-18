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
      if (orderKey) rows = rows.toSorted((a, b) => (a[orderKey] as number) - (b[orderKey] as number))
      if (limit) rows = rows.slice(0, Number(limit))
      return [rows.map((row) => ({ ...row }))]
    },
  }
}
