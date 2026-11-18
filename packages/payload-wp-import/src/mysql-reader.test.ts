import { describe, expect, it } from 'vitest'

import { MysqlReader, type MysqlConnection } from './mysql-reader'

const fakeConnection = (pages: Record<string, unknown>[][]) => {
  const calls: { sql: string; params?: unknown[] }[] = []
  let ended = false
  const connection: MysqlConnection = {
    async query(sql, params) {
      calls.push({ sql, params })
      return [sql.startsWith('SET') ? {} : (pages.shift() ?? [])]
    },
    async end() {
      ended = true
    },
  }
  return { calls, connection, isEnded: () => ended }
}

const connect = async () => fakeConnection([]).connection

describe('MysqlReader', () => {
  it('requires a connection string', () => {
    const previous = process.env.WP_IMPORT_MYSQL_URL
    delete process.env.WP_IMPORT_MYSQL_URL
    try {
      expect(() => new MysqlReader()).toThrow(/WP_IMPORT_MYSQL_URL/)
    } finally {
      if (previous !== undefined) process.env.WP_IMPORT_MYSQL_URL = previous
    }
  })

  it('applies the table prefix and rejects unsafe identifiers', () => {
    expect(new MysqlReader({ connect }).table('posts')).toBe('wp_posts')
    expect(new MysqlReader({ connect, prefix: 'jr9_' }).table('users')).toBe('jr9_users')
    expect(() => new MysqlReader({ connect, prefix: 'wp_; DROP' })).toThrow(/Invalid/)
    expect(() => new MysqlReader({ connect }).table('posts`--')).toThrow(/Invalid/)
  })

  it('pages with keyset until a short page, passing params in order', async () => {
    const { calls, connection } = fakeConnection([
      [{ ID: 1 }, { ID: 2 }],
      [{ ID: 3 }, { ID: 4 }],
      [{ ID: 5 }],
    ])
    const reader = new MysqlReader({ connect: async () => connection, pageSize: 2 })
    const ids: number[] = []
    for await (const row of reader.rows<{ ID: number }>('posts', {
      where: 'post_type = ?',
      params: ['job_listing'],
    })) {
      ids.push(row.ID)
    }

    expect(ids).toEqual([1, 2, 3, 4, 5])
    const selects = calls.filter((call) => call.sql.startsWith('SELECT'))
    expect(selects).toHaveLength(3)
    expect(selects[0]!.sql).toContain('FROM `wp_posts`')
    expect(selects[0]!.sql).toContain('ORDER BY `ID` ASC LIMIT 2')
    expect(selects[0]!.params).toEqual(['job_listing'])
    expect(selects[1]!.params).toEqual(['job_listing', 2])
    expect(selects[2]!.params).toEqual(['job_listing', 4])
  })

  it('opens the session read-only once, and refuses non-SELECT statements', async () => {
    const { calls, connection, isEnded } = fakeConnection([[], []])
    const reader = new MysqlReader({ connect: async () => connection })

    await expect(reader.query('DELETE FROM wp_posts')).rejects.toThrow(/SELECT/)
    await reader.query('SELECT 1')
    await reader.query('SELECT 2')
    await reader.close()

    expect(calls.map((call) => call.sql)).toEqual([
      'SET SESSION TRANSACTION READ ONLY',
      'SELECT 1',
      'SELECT 2',
    ])
    expect(isEnded()).toBe(true)
  })
})
