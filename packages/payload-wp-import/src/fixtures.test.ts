import { describe, expect, it } from 'vitest'

import { MysqlReader } from './mysql-reader'
import { runImport } from './run-import'
import { createFixtureConnection } from './test/fixtures'
import { createFakePayload } from './test-utils'
import type { Importer } from './types'

type Post = { ID: number; post_status: string; post_title: string }

const readerFor = (pageSize = 2) => {
  const connection = createFixtureConnection()
  return { connection, reader: new MysqlReader({ connect: async () => connection, pageSize }) }
}

const terms: Importer<{ term_id: number; name: string; slug: string }> = {
  name: 'terms',
  collection: 'job-types',
  dependsOn: [],
  read: (reader) => reader.rows('terms', { key: 'term_id' }),
  map: (row) => ({ legacyId: row.term_id, data: { name: row.name, slug: row.slug } }),
}

// A jobs-shaped importer: posts of one type and status, plus their meta, like PJ-64 will do.
const jobs: Importer<Post & { meta: Record<string, string> }> = {
  name: 'jobs',
  collection: 'jobs',
  dependsOn: ['terms'],
  read: async function* (reader) {
    for await (const post of reader.rows<Post>('posts', {
      where: 'post_type = ? AND post_status IN (?, ?)',
      params: ['job_listing', 'publish', 'expired'],
    })) {
      const meta = await reader.query<{ meta_key: string; meta_value: string }>(
        `SELECT * FROM \`${reader.table('postmeta')}\` WHERE post_id = ?`,
        [post.ID],
      )
      yield { ...post, meta: Object.fromEntries(meta.map((m) => [m.meta_key, m.meta_value])) }
    }
  },
  map: (row) =>
    row.post_title
      ? {
          legacyId: row.ID,
          data: {
            company: row.meta['_Company'] ?? null,
            featured: row.meta['_jr_featured-listings'] === '1',
            title: row.post_title,
            xeroInvoiceId: row.meta['_xero_invoice_id'] ?? null,
          },
        }
      : null,
}

describe('import against WordPress fixtures', () => {
  it('pages through posts and filters by type and status', async () => {
    const { reader, connection } = readerFor(2)
    const ids: number[] = []
    for await (const post of reader.rows<Post>('posts', {
      where: 'post_type = ?',
      params: ['job_listing'],
    })) {
      ids.push(post.ID)
    }

    expect(ids).toEqual([101, 102, 103, 105, 106])
    // 5 matching rows at page size 2: pages of 2, 2, 1.
    expect(connection.queries.filter((q) => q.startsWith('SELECT'))).toHaveLength(3)
  })

  it('imports terms then jobs with meta, skipping untitled rows and non-listings', async () => {
    const { payload, store } = createFakePayload()
    const { reader } = readerFor()
    const summary = await runImport({ importers: [jobs, terms], payload, reader, tenant: 1 })

    expect(summary.order).toEqual(['terms', 'jobs'])
    expect(summary.importers.terms).toMatchObject({ created: 3, failed: 0 })
    // Published/expired job_listing only: 101, 102, 105, 106. The untitled one (106) is skipped;
    // the draft (103) and the page (104) are never read.
    expect(summary.importers.jobs).toMatchObject({ created: 3, skipped: 1, failed: 0 })
    expect(store.jobs!.map((doc) => doc.legacyId)).toEqual([101, 102, 105])
    expect(store.jobs![0]).toMatchObject({ company: 'Example Resort Ltd', featured: true, tenant: 1 })
    expect(store.jobs![1]).toMatchObject({ company: 'Sample Charters', featured: false, xeroInvoiceId: null })
    expect(store.jobs![2]).toMatchObject({ xeroInvoiceId: 'inv-0001' })
  })

  it('a second run over the same fixtures creates nothing', async () => {
    const { payload, store } = createFakePayload()
    const importers = [terms, jobs]
    await runImport({ importers, payload, reader: readerFor().reader, tenant: 1 })
    const second = await runImport({ importers, payload, reader: readerFor().reader, tenant: 1 })

    expect(second.importers.jobs).toMatchObject({ created: 0, updated: 3 })
    expect(store.jobs).toHaveLength(3)
    expect(store['job-types']).toHaveLength(3)
  })

  it('the reader only ever sends SELECTs and a READ ONLY session statement', async () => {
    const { payload } = createFakePayload()
    const { reader, connection } = readerFor()
    await runImport({ importers: [terms, jobs], payload, reader, tenant: 1 })

    expect(connection.queries[0]).toBe('SET SESSION TRANSACTION READ ONLY')
    expect(connection.queries.slice(1).every((q) => q.startsWith('SELECT'))).toBe(true)
  })
})
