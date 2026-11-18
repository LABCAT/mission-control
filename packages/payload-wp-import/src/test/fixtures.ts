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
