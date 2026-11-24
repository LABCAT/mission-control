import { describe, expect, it } from 'vitest'

import { formatSummary, parseArgs, runCli } from './cli'
import { runImport } from './run-import'
import { createFakePayload, fakeReader, rowsImporter } from './test-utils'

const jobs = (rows: { id: number }[], overrides = {}) =>
  rowsImporter('jobs', rows, { prune: true, ...overrides })

const seed = () =>
  createFakePayload({
    jobs: [
      { id: 1, legacyId: 10, tenant: 1 },
      { id: 2, legacyId: 11, tenant: 1 },
      { id: 3, legacyId: 12, tenant: 2 }, // another tenant's imported job
      { id: 4, tenant: 1 }, // created natively: no legacyId
    ],
  })

const sync = (
  importers: ReturnType<typeof rowsImporter>[],
  payload: ReturnType<typeof createFakePayload>['payload'],
  extra: Record<string, unknown> = {},
) => runImport({ importers, payload, prune: true, reader: fakeReader, tenant: 1, ...extra })

describe('sync deletions (@S-330)', () => {
  it('lists what it would delete in a dry run and deletes nothing', async () => {
    const { payload, store } = seed()
    const lines: string[] = []

    const summary = await sync([jobs([{ id: 10 }])], payload, { dryRun: true, log: (l: string) => lines.push(l) })

    expect(summary.deletions).toEqual([
      { applied: false, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 },
    ])
    expect(store.jobs).toHaveLength(4)
    expect(lines.join('\n')).toMatch(/would delete jobs legacyId 11/)
  })

  it('deletes only this tenant\'s imported records that left the source, and logs each one', async () => {
    const { payload, store, writes } = seed()
    const lines: string[] = []

    const summary = await sync([jobs([{ id: 10 }])], payload, { log: (l: string) => lines.push(l) })

    expect(summary.deletions).toEqual([
      { applied: true, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 },
    ])
    expect(store.jobs!.map((d) => d.id).toSorted()).toEqual([1, 3, 4]) // other tenant + native doc kept
    expect(writes.filter((w) => w.op === 'delete')).toHaveLength(1)
    expect(lines.join('\n')).toMatch(/deleted jobs legacyId 11/)
  })

  it('never deletes unless asked to prune', async () => {
    const { payload, store } = seed()

    const summary = await runImport({ importers: [jobs([{ id: 10 }])], payload, reader: fakeReader, tenant: 1 })

    expect(summary.deletions).toEqual([])
    expect(store.jobs).toHaveLength(4)
  })

  it('never deletes for an importer that did not opt in', async () => {
    const { payload, store } = seed()

    await sync([rowsImporter('jobs', [{ id: 10 }])], payload)

    expect(store.jobs).toHaveLength(4)
  })

  it('refuses to delete when the source gave no rows', async () => {
    const { payload, store } = seed()

    const summary = await sync([jobs([])], payload)

    expect(summary.deletions).toEqual([])
    expect(summary.importers.jobs!.pruneRefused).toMatch(/no rows/)
    expect(store.jobs).toHaveLength(4)
  })

  it('refuses to delete when a row failed or was skipped, since the read is then not the full list', async () => {
    const failing = seed()
    const failed = await sync(
      [jobs([{ id: 10 }, { id: 13 }], { map: (row: { id: number }) => { if (row.id === 13) throw new Error('bad'); return { data: {}, legacyId: row.id } } })],
      failing.payload,
    )
    expect(failed.importers.jobs!.pruneRefused).toMatch(/failed/)
    expect(failing.store.jobs).toHaveLength(4)

    const skipping = seed()
    const skipped = await sync(
      [jobs([{ id: 10 }, { id: 13 }], { map: (row: { id: number }) => (row.id === 13 ? { skip: 'inactive' } : { data: {}, legacyId: row.id }) })],
      skipping.payload,
    )
    expect(skipped.importers.jobs!.pruneRefused).toMatch(/skipped/)
    expect(skipping.store.jobs).toHaveLength(4)
  })

  it('deletes the document of a row the source now skips as removed, but keeps one skipped for bad data', async () => {
    const { payload, store } = seed()
    const map = (row: { id: number }) =>
      row.id === 11
        ? { legacyId: 11, skip: 'status-trash' } // left the site
        : row.id === 12
          ? { keep: true, legacyId: 12, skip: 'no-title' } // data problem, other tenant anyway
          : { data: {}, legacyId: row.id }

    const summary = await sync([jobs([{ id: 10 }, { id: 11 }, { id: 12 }], { map })], payload)

    expect(summary.deletions.map((d) => d.legacyId)).toEqual([11])
    expect(store.jobs!.map((d) => d.id).toSorted()).toEqual([1, 3, 4])
  })

  it('keeps the imported document of a row skipped for bad data @S-330', async () => {
    const { payload, store } = createFakePayload({
      jobs: [
        { id: 1, legacyId: 10, tenant: 1 },
        { id: 2, legacyId: 11, tenant: 1 },
      ],
    })
    const map = (row: { id: number }) =>
      row.id === 11 ? { keep: true, legacyId: 11, skip: 'no-title' } : { data: {}, legacyId: row.id }

    const summary = await sync([jobs([{ id: 10 }, { id: 11 }], { map })], payload)

    expect(summary.deletions).toEqual([])
    expect(store.jobs).toHaveLength(2)
  })

  it('refuses to delete when the read aborted', async () => {
    const { payload, store } = seed()
    const broken = jobs([], {
      read: async function* () {
        yield { id: 10 }
        throw new Error('connection lost')
      },
    })

    const summary = await sync([broken], payload)

    expect(summary.importers.jobs!.aborted).toBeDefined()
    expect(store.jobs).toHaveLength(4)
  })

  it('records a failed delete without stopping', async () => {
    const { payload } = seed()
    payload.delete = async () => {
      throw new Error('constraint violation')
    }

    const summary = await sync([jobs([{ id: 10 }])], payload)

    expect(summary.errors).toEqual([{ importer: 'jobs', legacyId: 11, message: expect.stringMatching(/delete.*constraint/) }])
    expect(summary.deletions[0]!.applied).toBe(false)
  })

  it('does not prune importers that adopt existing records or live in another scope', async () => {
    const { payload, store } = seed()
    const adopting = jobs([{ id: 10 }], { findExisting: async () => undefined })

    const summary = await sync([adopting], payload)

    expect(summary.importers.jobs!.pruneRefused).toMatch(/adopt/)
    expect(store.jobs).toHaveLength(4)
  })
})

describe('sync credential refresh (@S-331)', () => {
  const users = (hash: string | null) =>
    rowsImporter('users', [{ id: 5 }], {
      map: (row: { id: number }) => ({
        data: {},
        legacyId: row.id,
        ...(hash ? { refreshWhileSet: { legacyPasswordHash: hash } } : {}),
      }),
    })

  const run = (docs: Record<string, unknown>[], hash: string | null, extra = {}) => {
    const fake = createFakePayload({ users: docs as never })
    return runImport({ importers: [users(hash)], payload: fake.payload, reader: fakeReader, refreshCredentials: true, tenant: 1, ...extra }).then(
      (summary) => ({ ...fake, summary }),
    )
  }

  it('replaces the hash of a user who has not signed in yet', async () => {
    const { store, summary } = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'old', tenant: 1 }], 'new')

    expect(store.users![0]!.legacyPasswordHash).toBe('new')
    expect(summary.importers.users!.refreshed).toBe(1)
  })

  it('never brings back a hash for a user who already claimed the account', async () => {
    const { store, summary } = await run([{ id: 1, legacyId: 5, legacyPasswordHash: null, tenant: 1 }], 'new')

    expect(store.users![0]!.legacyPasswordHash).toBeNull()
    expect(summary.importers.users!.refreshed ?? 0).toBe(0)
  })

  it('leaves an unchanged hash alone, and never blanks one when the legacy hash is empty', async () => {
    const same = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'same', tenant: 1 }], 'same')
    expect(same.summary.importers.users!.refreshed ?? 0).toBe(0)

    const empty = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'kept', tenant: 1 }], null)
    expect(empty.store.users![0]!.legacyPasswordHash).toBe('kept')
  })

  it('does nothing in a dry run, or unless refresh is on', async () => {
    const dry = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'old', tenant: 1 }], 'new', { dryRun: true })
    expect(dry.store.users![0]!.legacyPasswordHash).toBe('old')
    expect(dry.summary.importers.users!.refreshed).toBe(1)

    const off = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'old', tenant: 1 }], 'new', { refreshCredentials: false })
    expect(off.store.users![0]!.legacyPasswordHash).toBe('old')
  })

  it("only touches the run's tenant", async () => {
    const { store } = await run([{ id: 1, legacyId: 5, legacyPasswordHash: 'old', tenant: 2 }], 'new')

    expect(store.users![0]!.legacyPasswordHash).toBe('old')
  })
})

describe('sync command (@S-332)', () => {
  it('parses sync as dry-run by default, and --apply / --prune', () => {
    expect(parseArgs(['sync', '--tenant', 'vwok'])).toMatchObject({ apply: false, dryRun: true, entity: 'sync', prune: false })
    expect(parseArgs(['sync', '--tenant', 'vwok', '--apply', '--prune'])).toMatchObject({ apply: true, dryRun: false, prune: true })
  })

  it.each([
    [['sync', '--tenant', 'vwok', '--apply', '--dry-run'], /--apply and --dry-run/],
    [['sync', '--tenant', 'vwok', '--limit', '5'], /--limit/],
    [['jobs', '--tenant', 'vwok', '--apply'], /only for sync/],
    [['jobs', '--tenant', 'vwok', '--prune'], /only for sync/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message)
  })

  it('runs every importer, refreshes credentials and prunes only on --apply --prune', async () => {
    const make = () => ({
      ...createFakePayload({
        jobs: [
          { id: 1, legacyId: 10, tenant: 1 },
          { id: 2, legacyId: 11, tenant: 1 },
        ],
        tenants: [{ id: 1, slug: 'vwok' }],
      }),
    })
    const registry = { jobs: jobs([{ id: 10 }]) }
    const logs: string[] = []

    const dry = make()
    expect(await runCli({ argv: ['sync', '--tenant', 'vwok', '--prune'], log: (l) => logs.push(l), payload: dry.payload, reader: fakeReader, registry })).toBe(0)
    expect(dry.store.jobs).toHaveLength(2)
    expect(logs.join('\n')).toMatch(/Dry run: nothing was written/)
    expect(logs.join('\n')).toMatch(/would delete jobs legacyId 11/)

    const applied = make()
    expect(await runCli({ argv: ['sync', '--tenant', 'vwok', '--apply'], log: () => {}, payload: applied.payload, reader: fakeReader, registry })).toBe(0)
    expect(applied.store.jobs).toHaveLength(2) // --apply alone never deletes

    const pruned = make()
    expect(await runCli({ argv: ['sync', '--tenant', 'vwok', '--apply', '--prune'], log: () => {}, payload: pruned.payload, reader: fakeReader, registry })).toBe(0)
    expect(pruned.store.jobs!.map((d) => d.id)).toEqual([1])
  })

  it('lists deletions in the summary', () => {
    const text = formatSummary({
      deletions: [{ applied: true, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 }],
      dryRun: false,
      errors: [],
      importers: { jobs: { created: 0, failed: 0, skipped: 0, updated: 1 } },
      order: ['jobs'],
    })

    expect(text).toMatch(/Deleted \(1\)/)
  })
})
