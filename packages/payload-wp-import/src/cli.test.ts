import { describe, expect, it } from 'vitest'

import { parseArgs, runCli, selectImporters } from './cli'
import { createFakePayload, fakeReader, rowsImporter } from './test-utils'

describe('parseArgs', () => {
  it('parses entity, tenant, flags and --flag=value', () => {
    expect(parseArgs(['terms', '--tenant', 'vwok', '--dry-run', '--limit=5'])).toEqual({
      dryRun: true,
      entity: 'terms',
      limit: 5,
      tenant: 'vwok',
    })
  })

  it.each([
    [['terms'], /--tenant/],
    [['--tenant', 'vwok'], /exactly one entity/],
    [['a', 'b', '--tenant', 'vwok'], /exactly one entity/],
    [['terms', '--tenant'], /needs a value/],
    [['terms', '--tenant', 'vwok', '--limit', '0'], /positive integer/],
    [['terms', '--tenant', 'vwok', '--limit', 'ten'], /positive integer/],
    [['terms', '--tenant', 'vwok', '--force'], /Unknown option/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message)
  })
})

describe('selectImporters', () => {
  const registry = {
    terms: rowsImporter('terms', []),
    users: rowsImporter('users', []),
    jobs: rowsImporter('jobs', [], { dependsOn: ['terms'] }),
  }

  it('selects an entity with its dependencies only', () => {
    expect(selectImporters(registry, 'jobs').map((i) => i.name).toSorted()).toEqual(['jobs', 'terms'])
  })

  it('selects everything for "all"', () => {
    expect(selectImporters(registry, 'all')).toHaveLength(3)
  })

  it('lists available entities for an unknown one', () => {
    expect(() => selectImporters(registry, 'nope')).toThrow(/Unknown entity "nope".*terms, users, jobs/)
  })

  it('rejects a registry with a missing dependency, even for an entity that does not use it', () => {
    const broken = {
      ...registry,
      orders: rowsImporter('orders', [], { dependsOn: ['jobs', 'missing'] }),
    }

    expect(() => selectImporters(broken, 'terms')).toThrow(/"orders" depends on "missing"/)
    expect(() => selectImporters(broken, 'all')).toThrow(/depends on "missing"/)
  })

  it('rejects a registry key that does not match the importer name', () => {
    expect(() => selectImporters({ terms: rowsImporter('other', []) }, 'terms')).toThrow(
      /key "terms" does not match/,
    )
  })

  it('refuses an empty registry, for "all" and for named entities', () => {
    expect(() => selectImporters({}, 'all')).toThrow(/No importers are registered yet/)
    expect(() => selectImporters({}, 'terms')).toThrow(/No importers are registered yet/)
  })
})

describe('runCli', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const setup = () => {
    const fake = createFakePayload({ tenants: [{ id: 7, slug: 'vwok' }] })
    const lines: string[] = []
    const registry = {
      terms: rowsImporter('terms', [{ id: 1 }, { id: 2 }, { id: 3 }]),
    }
    const run = (argv: string[]) =>
      runCli({ argv, log: (l) => lines.push(l), payload: fake.payload, reader: fakeReader, registry })
    return { ...fake, lines, run }
  }

  it('resolves the tenant by slug and stamps its id on imported docs', async () => {
    const { run, store, lines } = setup()

    expect(await run(['terms', '--tenant', 'vwok'])).toBe(0)
    expect(store.terms!.every((doc) => doc.tenant === 7)).toBe(true)
    expect(lines.join('\n')).toMatch(/terms: created 3, updated 0, skipped 0, failed 0/)
  })

  it('--limit caps rows per importer and --dry-run writes nothing', async () => {
    const { run, store, writes, lines } = setup()

    expect(await run(['terms', '--tenant', 'vwok', '--limit', '2', '--dry-run'])).toBe(0)
    expect(writes).toEqual([])
    expect(store.terms).toBeUndefined()
    expect(lines.join('\n')).toMatch(/Dry run.*\n\s+terms: created 2/s)
  })

  it('gives a clear error and exit code 2 for an unknown tenant or entity', async () => {
    const { run, lines, writes } = setup()

    expect(await run(['terms', '--tenant', 'nope'])).toBe(2)
    expect(await run(['bogus', '--tenant', 'vwok'])).toBe(2)
    expect(lines.join('\n')).toMatch(/Unknown tenant "nope"/)
    expect(lines.join('\n')).toMatch(/Unknown entity "bogus"/)
    expect(writes).toEqual([])
  })

  it('--limit stops right after the Nth row without pulling another from the reader', async () => {
    const { payload } = createFakePayload({ tenants: [{ id: 7, slug: 'vwok' }] })
    let pulled = 0
    let closed = false
    const source = rowsImporter('terms', [], {
      read: () => ({
        [Symbol.asyncIterator]: () => {
          let id = 0
          return {
            next: async () => {
              pulled++
              return { done: false, value: { id: ++id } }
            },
            return: async () => {
              closed = true
              return { done: true, value: undefined }
            },
          }
        },
      }),
    })
    const code = await runCli({
      argv: ['terms', '--tenant', 'vwok', '--limit', '2'],
      log: () => {},
      payload,
      reader: fakeReader,
      registry: { terms: source },
    })

    expect(code).toBe(0)
    expect(pulled).toBe(2)
    expect(closed).toBe(true)
  })

  it('exits non-zero with a clear message for "all" on an empty registry', async () => {
    const { payload } = createFakePayload({ tenants: [{ id: 7, slug: 'vwok' }] })
    const lines: string[] = []
    const code = await runCli({
      argv: ['all', '--tenant', 'vwok'],
      log: (l) => lines.push(l),
      payload,
      reader: fakeReader,
      registry: {},
    })

    expect(code).toBe(2)
    expect(lines.join('\n')).toMatch(/No importers are registered yet/)
  })

  it('exits 1 when rows failed, and prints the errors', async () => {
    const { payload } = createFakePayload({ tenants: [{ id: 7, slug: 'vwok' }] })
    const lines: string[] = []
    const failing = rowsImporter('terms', [{ id: 1 }], {
      map: () => {
        throw new Error('bad row')
      },
    })
    const code = await runCli({
      argv: ['all', '--tenant', 'vwok'],
      log: (l) => lines.push(l),
      payload,
      reader: fakeReader,
      registry: { terms: failing },
    })

    expect(code).toBe(1)
    expect(lines.join('\n')).toMatch(/failed 1[\s\S]*Errors \(1\)[\s\S]*bad row/)
  })
})
