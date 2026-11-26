import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bootTestPayload, type TestHarness } from '@mission-control/payload-jobs/test'

// mission-control: the migration lives in the CMS app; its backfill is checked against this package's key.
import { backfillAlertFilterKeys } from '../../../apps/cms/src/migrations/20261126_062949_job_alerts'
import { alertFilterKey } from './filters'

/**
 * The job_alerts migration adds `filter_key`; alerts saved before it have none, and the service
 * would treat a re-submitted search as new and store a second copy. The backfill must give each
 * existing row exactly the key `alertFilterKey` computes today.
 */
describe('job_alerts migration backfill @S-371', () => {
  let harness: TestHarness

  beforeAll(async () => {
    harness = await bootTestPayload({ collections: [] })
    const db = harness.payload.db.drizzle
    // Raw SQL runs outside the harness's schema, so these two tables are made and dropped here.
    await db.execute(sql`DROP TABLE IF EXISTS alert_subscriptions_rels, alert_subscriptions`)
    await db.execute(sql`CREATE TABLE alert_subscriptions (id serial PRIMARY KEY, keywords varchar, filter_key varchar)`)
    await db.execute(sql`CREATE TABLE alert_subscriptions_rels (id serial PRIMARY KEY, parent_id integer, path varchar, job_categories_id integer, job_types_id integer, locations_id integer)`)
  })

  afterAll(async () => {
    await harness.payload.db.drizzle.execute(sql`DROP TABLE IF EXISTS alert_subscriptions_rels, alert_subscriptions`)
    await harness.destroy()
  })

  it('gives existing alerts the key the service computes', async () => {
    const db = harness.payload.db.drizzle
    const insert = async (keywords: null | string, rels: Array<[string, number]>) => {
      const { rows } = await db.execute(sql`INSERT INTO alert_subscriptions (keywords) VALUES (${keywords}) RETURNING id`)
      const id = Number(rows[0]!.id)
      for (const [path, value] of rels) {
        const column = { categories: 'job_categories_id', locations: 'locations_id', types: 'job_types_id' }[path]!
        await db.execute(sql.raw(`INSERT INTO alert_subscriptions_rels (parent_id, path, ${column}) VALUES (${id}, '${path}', ${value})`))
      }
      return id
    }

    const everything = await insert(null, [])
    const blank = await insert('   ', [])
    const typed = await insert('  Senior   Nurse ', [['categories', 10], ['categories', 2], ['types', 3], ['locations', 7]])

    await backfillAlertFilterKeys(db as never)

    const keys = new Map(
      (await db.execute(sql`SELECT id, filter_key FROM alert_subscriptions`)).rows.map((row) => [Number(row.id), row.filter_key]),
    )

    expect(keys.get(everything)).toBe(alertFilterKey({}))
    expect(keys.get(blank)).toBe('')
    expect(keys.get(typed)).toBe(
      alertFilterKey({ categories: [10, 2], keywords: '  Senior   Nurse ', locations: [7], types: [3] }),
    )
  })
})
