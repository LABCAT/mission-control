import { describe, expect, it } from 'vitest'

import { formatSummary, parseArgs, runCli } from './cli'
import { runImport } from './run-import'
import { createFakePayload, fakeReader, rowsImporter } from './test-utils'

const cancel = (doc: Record<string, any>) => (doc.status === 'cancelled' ? undefined : { status: 'cancelled' })

const jobs = (rows: { id: number }[], overrides = {}) =>
  rowsImporter('jobs', rows, { removal: cancel, ...overrides })

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
) => runImport({ importers, payload, reader: fakeReader, syncRemovals: true, tenant: 1, ...extra })

describe('sync removals (@S-330)', () => {
  it('reports what left the legacy site and changes nothing by default', async () => {
    const { payload, store, writes } = seed()
    const lines: string[] = []

    const summary = await sync([jobs([{ id: 10 }])], payload, { log: (l: string) => lines.push(l) })

    expect(summary.removals).toEqual([
      { action: { status: 'cancelled' }, applied: false, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 },
    ])
    expect(store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')
    expect(writes.filter((w) => w.collection === 'jobs' && w.op === 'update')).toHaveLength(1) // only job 10's upsert
    expect(lines.join('\n')).toMatch(/no change made: jobs legacyId 11/)
  })

  it('with applyRemovals, applies the policy to this tenant\'s imported records that left the source, and logs it', async () => {
    const { payload, store } = seed()
    const lines: string[] = []

    const summary = await sync([jobs([{ id: 10 }])], payload, { applyRemovals: true, log: (l: string) => lines.push(l) })

    expect(summary.removals).toEqual([
      { action: { status: 'cancelled' }, applied: true, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 },
    ])
    expect(store.jobs).toHaveLength(4) // never hard-deleted
    expect(store.jobs!.find((d) => d.id === 2)).toMatchObject({ status: 'cancelled' })
    expect(store.jobs!.find((d) => d.id === 3)).not.toHaveProperty('status') // other tenant
    expect(store.jobs!.find((d) => d.id === 4)).not.toHaveProperty('status') // created in the CMS
    expect(lines.join('\n')).toMatch(/changed: jobs legacyId 11/)
  })

  it('marks its change as an import, so hooks can tell it from a staff action', async () => {
    const { payload, writes } = seed()
    const contexts: unknown[] = []
    const update = payload.update
    payload.update = async (args) => {
      if ((args.data as { status?: string }).status === 'cancelled') contexts.push(args.context)
      return update(args)
    }

    await sync([jobs([{ id: 10 }])], payload, { applyRemovals: true })

    expect(contexts).toEqual([{ wpImportSync: true }])
    expect(writes.length).toBeGreaterThan(0)
  })

  it('applies nothing in a dry run, and nothing again once a document is already off the site', async () => {
    const dry = seed()
    await sync([jobs([{ id: 10 }])], dry.payload, { applyRemovals: true, dryRun: true })
    expect(dry.store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')

    const again = seed()
    const first = await sync([jobs([{ id: 10 }])], again.payload, { applyRemovals: true })
    const second = await sync([jobs([{ id: 10 }])], again.payload, { applyRemovals: true })
    expect(first.removals).toHaveLength(1)
    expect(second.removals).toEqual([])
  })

  it('does nothing outside sync mode', async () => {
    const { payload, store } = seed()

    const summary = await runImport({ applyRemovals: true, importers: [jobs([{ id: 10 }])], payload, reader: fakeReader, tenant: 1 })

    expect(summary.removals).toEqual([])
    expect(store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')
  })

  it('ignores an importer without a removal policy', async () => {
    const { payload, store } = seed()

    const summary = await sync([rowsImporter('jobs', [{ id: 10 }])], payload, { applyRemovals: true })

    expect(summary.removals).toEqual([])
    expect(store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')
  })

  it('does not look at removals when the source gave no rows', async () => {
    const { payload } = seed()

    const summary = await sync([jobs([])], payload, { applyRemovals: true })

    expect(summary.removals).toEqual([])
    expect(summary.importers.jobs!.removalsRefused).toMatch(/no rows/)
  })

  it('does not look at removals when a row failed or a skipped row gave no id', async () => {
    const failing = seed()
    const failed = await sync(
      [jobs([{ id: 10 }, { id: 13 }], { map: (row: { id: number }) => { if (row.id === 13) throw new Error('bad'); return { data: {}, legacyId: row.id } } })],
      failing.payload,
      { applyRemovals: true },
    )
    expect(failed.importers.jobs!.removalsRefused).toMatch(/failed/)
    expect(failed.removals).toEqual([])

    const skipping = seed()
    const skipped = await sync(
      [jobs([{ id: 10 }, { id: 13 }], { map: (row: { id: number }) => (row.id === 13 ? { skip: 'inactive' } : { data: {}, legacyId: row.id }) })],
      skipping.payload,
      { applyRemovals: true },
    )
    expect(skipped.importers.jobs!.removalsRefused).toMatch(/no legacyId/)
    expect(skipped.removals).toEqual([])
  })

  it('treats a skipped row with an id as removed, unless it is skipped for bad data', async () => {
    const { payload, store } = seed()
    const map = (row: { id: number }) =>
      row.id === 11
        ? { legacyId: 11, skip: 'status-trash' } // left the site
        : row.id === 12
          ? { keep: true, legacyId: 12, skip: 'no-title' } // data problem
          : { data: {}, legacyId: row.id }

    const summary = await sync([jobs([{ id: 10 }, { id: 11 }, { id: 12 }], { map })], payload, { applyRemovals: true })

    expect(summary.removals.map((d) => d.legacyId)).toEqual([11])
    expect(store.jobs!.find((d) => d.id === 2)).toMatchObject({ status: 'cancelled' })
  })

  it('does not look at removals when the read aborted', async () => {
    const { payload } = seed()
    const broken = jobs([], {
      read: async function* () {
        yield { id: 10 }
        throw new Error('connection lost')
      },
    })

    const summary = await sync([broken], payload, { applyRemovals: true })

    expect(summary.importers.jobs!.aborted).toBeDefined()
    expect(summary.removals).toEqual([])
  })

  it('records a failed change without stopping', async () => {
    const { payload } = seed()
    const update = payload.update
    payload.update = async (args) => {
      if ((args.data as { status?: string }).status === 'cancelled') throw new Error('state machine says no')
      return update(args)
    }

    const summary = await sync([jobs([{ id: 10 }])], payload, { applyRemovals: true })

    expect(summary.errors).toEqual([{ importer: 'jobs', legacyId: 11, message: expect.stringMatching(/removal failed.*state machine/) }])
    expect(summary.removals[0]!.applied).toBe(false)
  })

  it('never handles removals for an importer that adopts existing documents', async () => {
    const { payload } = seed()

    const summary = await sync([jobs([{ id: 10 }], { findExisting: async () => undefined })], payload, { applyRemovals: true })

    expect(summary.importers.jobs!.removalsRefused).toMatch(/adopt/)
    expect(summary.removals).toEqual([])
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

  it('leaves a user who has a Payload password alone, whatever the legacy hash says', async () => {
    const { store } = await run([{ hash: 'pbkdf2', id: 1, legacyId: 5, legacyPasswordHash: 'old', tenant: 1 }], 'new')

    expect(store.users![0]!.legacyPasswordHash).toBe('old')
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
  it('parses sync with its opt-in flags', () => {
    expect(parseArgs(['sync', '--tenant', 'vwok'])).toMatchObject({ applyDeletions: false, dryRun: false, entity: 'sync', refreshCredentials: false })
    expect(parseArgs(['sync', '--tenant', 'vwok', '--dry-run', '--apply-deletions', '--refresh-credentials'])).toMatchObject({
      applyDeletions: true,
      dryRun: true,
      refreshCredentials: true,
    })
  })

  it.each([
    [['sync', '--tenant', 'vwok', '--limit', '5'], /--limit/],
    [['jobs', '--tenant', 'vwok', '--apply-deletions'], /only for sync/],
    [['jobs', '--tenant', 'vwok', '--refresh-credentials'], /only for sync/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message)
  })

  const make = () =>
    createFakePayload({
      jobs: [
        { id: 1, legacyId: 10, tenant: 1 },
        { id: 2, legacyId: 11, tenant: 1 },
      ],
      tenants: [{ id: 1, slug: 'vwok' }],
    })
  const registry = { jobs: jobs([{ id: 10 }]) }

  it('runs every importer and only reports removals unless --apply-deletions', async () => {
    const logs: string[] = []
    const plain = make()
    expect(await runCli({ argv: ['sync', '--tenant', 'vwok'], log: (l) => logs.push(l), payload: plain.payload, reader: fakeReader, registry })).toBe(0)
    expect(plain.store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')
    expect(logs.join('\n')).toMatch(/Gone from the legacy site \(1, 0 changed\)/)

    const applied = make()
    expect(await runCli({ argv: ['sync', '--tenant', 'vwok', '--apply-deletions'], log: () => {}, payload: applied.payload, reader: fakeReader, registry })).toBe(0)
    expect(applied.store.jobs!.find((d) => d.id === 2)).toMatchObject({ status: 'cancelled' })

    const dry = make()
    await runCli({ argv: ['sync', '--tenant', 'vwok', '--dry-run', '--apply-deletions'], log: () => {}, payload: dry.payload, reader: fakeReader, registry })
    expect(dry.store.jobs!.find((d) => d.id === 2)).not.toHaveProperty('status')
  })

  it('a second run creates nothing', async () => {
    const fake = make()
    const argv = ['sync', '--tenant', 'vwok']
    await runCli({ argv, log: () => {}, payload: fake.payload, reader: fakeReader, registry: { jobs: jobs([{ id: 10 }, { id: 14 }]) } })
    const creates = fake.writes.filter((w) => w.op === 'create').length
    await runCli({ argv, log: () => {}, payload: fake.payload, reader: fakeReader, registry: { jobs: jobs([{ id: 10 }, { id: 14 }]) } })

    expect(creates).toBe(1)
    expect(fake.writes.filter((w) => w.op === 'create')).toHaveLength(1)
  })

  it('lists removals in the summary, with no personal data', () => {
    const text = formatSummary({
      dryRun: false,
      errors: [],
      importers: { jobs: { created: 0, failed: 0, skipped: 0, updated: 1 } },
      order: ['jobs'],
      removals: [{ action: { status: 'cancelled' }, applied: true, collection: 'jobs', id: 2, importer: 'jobs', legacyId: 11 }],
    })

    expect(text).toMatch(/Gone from the legacy site \(1, 1 changed\)/)
  })
})
