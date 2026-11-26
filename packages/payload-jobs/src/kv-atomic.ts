import type { Payload } from 'payload'

/**
 * Atomic steps on `payload.kv` records (PJ-109). The kv API reads and writes whole values, so two
 * requests that arrive together both see the same state and both write it back. A one-time code
 * needs better: "count this guess", "spend this code" and "count this address's failures" must each
 * be ONE statement the database runs on its own. These run against the kv table Payload already
 * has (`payload-kv`), so they add no schema.
 *
 * They need the Postgres adapter's pool. Without it (another adapter) `atomicKV` is null and the
 * caller falls back to the plain kv calls, which are correct one request at a time.
 */

type Query = (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

export type AtomicKV = {
  /**
   * Add one to `attempts` on the record at `key`, but only while it is below `max`.
   * Returns the new count, or null when the record is gone, already at the cap, or no longer the
   * record whose code hash is `codeHash` (a re-request replaced it since it was read).
   */
  claimAttempt: (key: string, max: number, codeHash: string) => Promise<null | number>
  /**
   * Store `record` at `key` only if nothing is there or what is there was issued at or before
   * `issuedBefore` (its `issuedAt`). Returns false when a newer record already holds the key, so of
   * any number of simultaneous requests exactly one reserves the right to issue and send.
   */
  reserve: (key: string, record: { issuedAt: number }, issuedBefore: number) => Promise<boolean>
  /**
   * Add one to a windowed counter at `key` (created on first use) and return the count in the
   * current window. A window that has ended starts again at 1.
   */
  countInWindow: (key: string, windowMs: number, now: number) => Promise<number>
  /**
   * Delete the record and return it, once: of any number of simultaneous callers one gets it.
   * With `match`, only a record whose `codeHash` or `tokenHash` is that value is taken, so a
   * request that read an older record cannot take the one that replaced it.
   */
  take: <T>(key: string, match?: { codeHash?: string; tokenHash?: string }) => Promise<null | T>
}

const identifier = (value: string): string => `"${value.replace(/"/g, '""')}"`

export const atomicKV = (payload: Payload): AtomicKV | null => {
  const db = payload.db as unknown as {
    pool?: { query?: Query }
    schemaName?: string
    tableNameMap?: Map<string, string>
  }
  const query = db.pool?.query?.bind(db.pool)
  if (!query) return null

  const table = `${db.schemaName ? `${identifier(db.schemaName)}.` : ''}${identifier(
    db.tableNameMap?.get('payload-kv') ?? 'payload_kv',
  )}`

  return {
    claimAttempt: async (key, max, codeHash) => {
      const { rows } = await query(
        `UPDATE ${table}
            SET data = jsonb_set(data, '{attempts}', to_jsonb(COALESCE((data->>'attempts')::int, 0) + 1))
          WHERE key = $1 AND data->>'codeHash' = $3
            AND COALESCE((data->>'attempts')::int, 0) < $2
        RETURNING (data->>'attempts')::int AS attempts`,
        [key, max, codeHash],
      )

      return rows[0] ? Number(rows[0].attempts) : null
    },

    countInWindow: async (key, windowMs, now) => {
      const { rows } = await query(
        `INSERT INTO ${table} (key, data)
              VALUES ($1, jsonb_build_object('count', 1, 'windowEnd', $2::bigint))
         ON CONFLICT (key) DO UPDATE
                SET data = CASE
                      WHEN (${table}.data->>'windowEnd')::bigint <= $3::bigint
                        THEN jsonb_build_object('count', 1, 'windowEnd', $2::bigint)
                      ELSE jsonb_set(${table}.data, '{count}', to_jsonb((${table}.data->>'count')::int + 1))
                    END
        RETURNING (data->>'count')::int AS count`,
        [key, now + windowMs, now],
      )

      return Number(rows[0]?.count ?? 1)
    },

    reserve: async (key, record, issuedBefore) => {
      const { rows } = await query(
        `INSERT INTO ${table} (key, data)
              VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE
                SET data = EXCLUDED.data
              WHERE COALESCE((${table}.data->>'issuedAt')::bigint, 0) <= $3::bigint
        RETURNING key`,
        [key, JSON.stringify(record), issuedBefore],
      )

      return rows.length > 0
    },

    take: async <T>(key: string, match?: { codeHash?: string; tokenHash?: string }) => {
      const { rows } = await query(
        `DELETE FROM ${table}
          WHERE key = $1
            AND ($2::text IS NULL OR data->>'codeHash' = $2)
            AND ($3::text IS NULL OR data->>'tokenHash' = $3)
        RETURNING data`,
        [key, match?.codeHash ?? null, match?.tokenHash ?? null],
      )

      return (rows[0]?.data as T | undefined) ?? null
    },
  }
}
