import { createConnection } from 'mysql2/promise'

export const MYSQL_URL_ENV = 'WP_IMPORT_MYSQL_URL'

/** The part of a mysql2 connection the reader uses; lets tests inject a fake. */
export type MysqlConnection = {
  end: () => Promise<void>
  query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown?]>
}

export type MysqlReaderOptions = {
  /** Open the connection. Defaults to mysql2 with the given URL. */
  connect?: () => Promise<MysqlConnection>
  /** Rows per select. Default 500. */
  pageSize?: number
  /** WordPress table prefix. Default `wp_`. */
  prefix?: string
  /** Connection string. Defaults to env `WP_IMPORT_MYSQL_URL`. */
  url?: string
}

export type PageOptions = {
  /** Primary key used for keyset paging. Default `ID`. */
  key?: string
  /** Static SQL condition, e.g. `post_type = ?`. Values go in `params`. */
  where?: string
  params?: unknown[]
  pageSize?: number
}

const IDENTIFIER = /^[A-Za-z0-9_]+$/

const identifier = (value: string, what: string): string => {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid ${what}: "${value}"`)
  return value
}

/**
 * Read-only access to a WordPress MySQL database. Only issues SELECTs, and puts the
 * session in READ ONLY mode so a writable user still cannot change anything.
 */
export class MysqlReader {
  readonly prefix: string
  readonly pageSize: number
  private connection?: MysqlConnection
  private readonly connect: () => Promise<MysqlConnection>

  constructor(options: MysqlReaderOptions = {}) {
    this.prefix = identifier(options.prefix ?? 'wp_', 'table prefix')
    this.pageSize = options.pageSize ?? 500
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) {
      throw new Error('pageSize must be a positive integer')
    }

    if (options.connect) {
      this.connect = options.connect
    } else {
      const url = options.url ?? process.env[MYSQL_URL_ENV]
      if (!url) throw new Error(`${MYSQL_URL_ENV} is not set`)
      this.connect = async () => {
        const connection = await createConnection(url)
        return connection as unknown as MysqlConnection
      }
    }
  }

  /** Full table name with the prefix, e.g. `table('posts')` → `wp_posts`. */
  table(name: string): string {
    return `${this.prefix}${identifier(name, 'table name')}`
  }

  /** Run a SELECT. Anything else is rejected. */
  async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> {
    if (!/^\s*select\b/i.test(sql)) throw new Error('MysqlReader only runs SELECT statements')
    const connection = await this.open()
    const [rows] = await connection.query(sql, params)
    return rows as Row[]
  }

  /** Stream a table in pages ordered by `key` (keyset paging, stable under inserts). */
  async *rows<Row extends Record<string, unknown> = Record<string, unknown>>(
    table: string,
    options: PageOptions = {},
  ): AsyncGenerator<Row> {
    const key = identifier(options.key ?? 'ID', 'key column')
    const pageSize = options.pageSize ?? this.pageSize
    const name = this.table(table)
    const condition = options.where ? ` AND (${options.where})` : ''
    let after: unknown = null

    while (true) {
      const keyset = after === null ? '' : ` AND \`${key}\` > ?`
      const params = [...(options.params ?? []), ...(after === null ? [] : [after])]
      const sql =
        `SELECT * FROM \`${name}\` WHERE 1 = 1${condition}${keyset} ` +
        `ORDER BY \`${key}\` ASC LIMIT ${pageSize}`
      const page = await this.query<Row>(sql, params)
      for (const row of page) yield row
      if (page.length < pageSize) return
      after = page[page.length - 1]![key]
    }
  }

  async close(): Promise<void> {
    const connection = this.connection
    this.connection = undefined
    await connection?.end()
  }

  private async open(): Promise<MysqlConnection> {
    if (!this.connection) {
      const connection = await this.connect()
      await connection.query('SET SESSION TRANSACTION READ ONLY')
      this.connection = connection
    }
    return this.connection
  }
}
