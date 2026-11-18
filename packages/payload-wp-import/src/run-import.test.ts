import { describe, expect, it } from 'vitest'

import { runImport, sortImporters } from './run-import'
import { createFakePayload, fakeReader, rowsImporter } from './test-utils'

const run = (
  importers: ReturnType<typeof rowsImporter>[],
  payload: ReturnType<typeof createFakePayload>['payload'],
  extra: { dryRun?: boolean; tenant?: number } = {},
) => runImport({ importers, payload, reader: fakeReader, tenant: extra.tenant ?? 1, ...extra })

describe('sortImporters', () => {
  it('puts dependencies first regardless of input order', () => {
    const sorted = sortImporters([
      rowsImporter('jobs', [], { dependsOn: ['orgs', 'terms'] }),
      rowsImporter('orgs', [], { dependsOn: ['users'] }),
      rowsImporter('users', []),
      rowsImporter('terms', []),
    ])
    const names = sorted.map((importer) => importer.name)

    expect(names.indexOf('users')).toBeLessThan(names.indexOf('orgs'))
    expect(names.indexOf('orgs')).toBeLessThan(names.indexOf('jobs'))
    expect(names.indexOf('terms')).toBeLessThan(names.indexOf('jobs'))
  })

  it('reports the cycle path', () => {
    expect(() =>
      sortImporters([
        rowsImporter('a', [], { dependsOn: ['b'] }),
        rowsImporter('b', [], { dependsOn: ['c'] }),
        rowsImporter('c', [], { dependsOn: ['a'] }),
      ]),
    ).toThrow(/cycle: a -> b -> c -> a/)
  })

  it('rejects unknown dependencies and duplicate names', () => {
    expect(() => sortImporters([rowsImporter('a', [], { dependsOn: ['nope'] })])).toThrow(
      /unknown "nope"/,
    )
    expect(() => sortImporters([rowsImporter('a', []), rowsImporter('a', [])])).toThrow(/Duplicate/)
  })
})

describe('runImport', () => {
  it('does not need a MySQL connection when there is nothing to run', async () => {
    const previous = process.env.WP_IMPORT_MYSQL_URL
    delete process.env.WP_IMPORT_MYSQL_URL
    try {
      const summary = await runImport({ importers: [], payload: createFakePayload().payload, tenant: 1 })
      expect(summary).toMatchObject({ errors: [], importers: {}, order: [] })
    } finally {
      if (previous !== undefined) process.env.WP_IMPORT_MYSQL_URL = previous
    }
  })

  it('is idempotent: a second run creates nothing and does not duplicate', async () => {
    const { payload, store } = createFakePayload()
    const importers = [rowsImporter('terms', [{ id: 1 }, { id: 2 }])]

    const first = await run(importers, payload)
    const second = await run(importers, payload)

    expect(first.importers.terms).toMatchObject({ created: 2, updated: 0 })
    expect(second.importers.terms).toMatchObject({ created: 0, updated: 2 })
    expect(store.terms).toHaveLength(2)
  })

  it('updates existing docs with new data', async () => {
    const { payload, store } = createFakePayload()
    await run([rowsImporter('terms', [{ id: 1, title: 'Old' }])], payload)
    await run([rowsImporter('terms', [{ id: 1, title: 'New' }])], payload)

    expect(store.terms![0]!.title).toBe('New')
  })

  it('matches by legacyId within the tenant only', async () => {
    const { payload, store } = createFakePayload({
      terms: [{ id: 5, legacyId: 1, tenant: 2, title: 'Other tenant' }],
    })
    const summary = await run([rowsImporter('terms', [{ id: 1 }])], payload, { tenant: 1 })

    expect(summary.importers.terms).toMatchObject({ created: 1, updated: 0 })
    expect(store.terms).toHaveLength(2)
    expect(store.terms![0]!.title).toBe('Other tenant')
  })

  it('stamps tenant and legacyId over anything the mapper returns', async () => {
    const { payload, store } = createFakePayload()
    const importer = rowsImporter('terms', [{ id: 7 }], {
      map: () => ({ legacyId: 7, data: { tenant: 99, legacyId: 99 } }),
    })
    await run([importer], payload, { tenant: 3 })

    expect(store.terms![0]).toMatchObject({ legacyId: 7, tenant: 3 })
  })

  it('dry run writes nothing but reports created vs updated', async () => {
    const { payload, writes, store } = createFakePayload({
      terms: [{ id: 5, legacyId: 1, tenant: 1 }],
    })
    const summary = await run([rowsImporter('terms', [{ id: 1 }, { id: 2 }, { id: 3 }])], payload, {
      dryRun: true,
    })

    expect(writes).toEqual([])
    expect(store.terms).toHaveLength(1)
    expect(summary.dryRun).toBe(true)
    expect(summary.importers.terms).toMatchObject({ created: 2, updated: 1, failed: 0 })
  })

  it('collects row failures without stopping, and counts skips', async () => {
    const { payload, store } = createFakePayload()
    const importer = rowsImporter('terms', [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], {
      map: (row: { id: number }) => {
        if (row.id === 2) throw new Error('bad row')
        if (row.id === 3) return null
        return { legacyId: row.id, data: {} }
      },
    })
    const summary = await run([importer], payload)

    expect(summary.importers.terms).toMatchObject({ created: 2, failed: 1, skipped: 1 })
    expect(summary.errors).toEqual([{ importer: 'terms', legacyId: undefined, message: 'bad row' }])
    expect(store.terms).toHaveLength(2)
  })

  it('records the legacyId when a write fails', async () => {
    const { payload } = createFakePayload()
    payload.create = async () => {
      throw new Error('validation failed')
    }
    const summary = await run([rowsImporter('terms', [{ id: 9 }])], payload)

    expect(summary.errors).toEqual([
      { importer: 'terms', legacyId: 9, message: 'validation failed' },
    ])
  })

  it('runs in dependency order and blocks dependents of an importer that could not read', async () => {
    const { payload, store } = createFakePayload()
    const ran: string[] = []
    const track = (name: string) => (rows: { id: number }[]) => () => {
      ran.push(name)
      return rows
    }
    const summary = await run(
      [
        rowsImporter('jobs', [{ id: 1 }], { dependsOn: ['users'], read: track('jobs')([{ id: 1 }]) }),
        rowsImporter('users', [], {
          read: () => {
            throw new Error('connection refused')
          },
        }),
        rowsImporter('terms', [{ id: 1 }], { read: track('terms')([{ id: 1 }]) }),
      ],
      payload,
    )

    expect(ran).toEqual(['terms'])
    expect(summary.importers.users!.aborted).toMatch(/connection refused/)
    expect(summary.importers.jobs!.aborted).toMatch(/dependency "users"/)
    expect(store.terms).toHaveLength(1)
    expect(store.jobs).toBeUndefined()
  })
})
