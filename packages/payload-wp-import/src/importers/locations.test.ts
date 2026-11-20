import { parseVanuatuLocations } from '@mission-control/payload-jobs'
import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, locationDocs, taxonomyTables } from '../test/fixtures'
import {
  type LocationDoc,
  LOCATION_META_KEYS,
  buildLocationIndex,
  legacyAddressLabel,
  locationsImporter,
  parseLegacyAddress,
  readLegacyLocationLabels,
  resolveLegacyLocation,
  resolveLegacyLocations,
} from './locations'

const readerFor = (tables = taxonomyTables) =>
  new MysqlReader({ connect: async () => createFixtureConnection(tables), pageSize: 2 })

const index = buildLocationIndex(locationDocs)

/** The seeded Vanuatu tree as `locations` documents, so the resolver is checked on real data. */
const vanuatuDocs = (): LocationDoc[] => {
  const docs: LocationDoc[] = []
  const bySlug = new Map<string, LocationDoc>()

  for (const seed of parseVanuatuLocations()) {
    const parent = seed.parentSlug === null ? null : (bySlug.get(seed.parentSlug) ?? null)
    const doc: LocationDoc = {
      id: docs.length + 1,
      name: seed.name,
      parent,
      slug: seed.slug,
    }
    docs.push(doc)
    bySlug.set(seed.slug, doc)
  }

  return docs
}

/** A tenant tree where two islands each have a `Luganville`, to prove the parent is respected. */
const duplicateTree = buildLocationIndex([
  { id: 1, kind: 'island', name: 'Efate', parent: null, slug: 'efate' },
  { id: 2, kind: 'town', name: 'Port Vila', parent: { id: 1, name: 'Efate', slug: 'efate' }, slug: 'port-vila' },
  { id: 3, kind: 'island', name: 'Espiritu Santo', parent: null, slug: 'espiritu-santo' },
  { id: 4, kind: 'town', name: 'Luganville', parent: { id: 3, name: 'Espiritu Santo', slug: 'espiritu-santo' }, slug: 'luganville' },
  { id: 6, kind: 'island', name: 'Malekula', parent: null, slug: 'malekula' },
  { id: 7, kind: 'town', name: 'Luganville', parent: { id: 6, name: 'Malekula', slug: 'malekula' }, slug: 'luganville-malekula' },
])

describe('parseLegacyAddress', () => {
  it('splits on the comma the job form writes, and drops empty parts', () => {
    expect(parseLegacyAddress('Port Vila, Efate')).toEqual(['Port Vila', 'Efate'])
    expect(parseLegacyAddress('  Luganville ,  Espiritu Santo ')).toEqual(['Luganville', 'Espiritu Santo'])
    expect(parseLegacyAddress('Efate')).toEqual(['Efate'])
    expect(parseLegacyAddress(' , , ')).toEqual([])
    expect(parseLegacyAddress(null)).toEqual([])
  })

  it('decodes entities the legacy editor stored in the address', () => {
    expect(parseLegacyAddress('Sulphur Bay, Tanna &amp; outer islands')).toEqual([
      'Sulphur Bay',
      'Tanna & outer islands',
    ])
  })
})

describe('resolveLegacyLocation', () => {
  it('matches a `Town, Island` pair to the town', () => {
    expect(resolveLegacyLocation('Port Vila, Efate', index)).toMatchObject({
      doc: { id: 2, slug: 'port-vila' },
      via: 'name-and-parent',
    })
  })

  it('matches an island on its own', () => {
    expect(resolveLegacyLocation('Efate', index)).toMatchObject({
      doc: { id: 1, slug: 'efate' },
      via: 'name',
    })
  })

  it('respects the parent when two islands have a town of the same name', () => {
    expect(resolveLegacyLocation('Luganville, Espiritu Santo', duplicateTree)?.doc.id).toBe(4)
    expect(resolveLegacyLocation('Luganville, Malekula', duplicateTree)?.doc.id).toBe(7)
  })

  it('falls back to the island when the town is not under it', () => {
    // Port Vila is under Efate, so `Port Vila, Malekula` can only mean Malekula.
    expect(resolveLegacyLocation('Port Vila, Malekula', duplicateTree)?.doc.id).toBe(6)
  })

  it('falls back to the place name in a free-text address', () => {
    expect(resolveLegacyLocation('Main Street, Santo', index)?.doc).toMatchObject({
      slug: 'espiritu-santo',
    })
    expect(
      resolveLegacyLocation(
        'National University of Vanuatu, Agriculture College Campus, Santo, Vanuatu',
        index,
      )?.doc,
    ).toMatchObject({ slug: 'espiritu-santo' })
  })

  it('ignores case, punctuation and the spaces inside a name', () => {
    expect(resolveLegacyLocation('port-vila', index)?.doc.id).toBe(2)
    expect(resolveLegacyLocation('PORT VILA', index)?.doc.id).toBe(2)
    expect(resolveLegacyLocation('Whitesands', index)?.doc.id).toBe(5)
    expect(resolveLegacyLocation('White Sands', index)?.doc.id).toBe(5)
  })

  it('returns null for a place the tenant tree does not have', () => {
    expect(resolveLegacyLocation('Nowhere, Atlantis', index)).toBeNull()
    expect(resolveLegacyLocation('', index)).toBeNull()
  })

  it('uses the Santo alias only when the tenant has Espiritu Santo', () => {
    expect(resolveLegacyLocation('Santo', index)?.doc.id).toBe(3)

    const elsewhere = buildLocationIndex([
      { id: 1, kind: 'island', name: 'Efate', parent: null, slug: 'efate' },
    ])
    expect(resolveLegacyLocation('Santo', elsewhere)).toBeNull()
  })
})

describe('resolveLegacyLocation against the seeded Vanuatu tree', () => {
  const seeds = parseVanuatuLocations()
  const vanuatu = buildLocationIndex(vanuatuDocs())
  const roots = seeds.filter((seed) => seed.parentSlug === null)
  const pairs = seeds
    .filter((seed) => seed.parentSlug !== null)
    .map((seed) => ({ town: seed, island: roots.find((root) => root.slug === seed.parentSlug)! }))

  it('resolves every picker pair the seed writes to the town under that island', () => {
    expect(pairs.length).toBeGreaterThan(20)

    for (const { town, island } of pairs) {
      const match = resolveLegacyLocation(`${town.name}, ${island.name}`, vanuatu)
      expect(match?.doc.slug, `${town.name}, ${island.name}`).toBe(town.slug)
      expect(match?.via, `${town.name}, ${island.name}`).toBe('name-and-parent')
    }
  })

  it('resolves every root picker key on its own, catch-alls included', () => {
    for (const root of roots) {
      expect(resolveLegacyLocation(root.name, vanuatu)?.doc.slug, root.name).toBe(root.slug)
    }
  })

  it('leaves a town without its island to the town, not to another island', () => {
    // `Luganville` on its own resolves to the town; `Luganville, Efate` has no such pair, so the
    // island wins rather than a town in a different island's subtree.
    expect(resolveLegacyLocation('Luganville', vanuatu)?.doc).toMatchObject({ slug: 'luganville' })
    expect(resolveLegacyLocation('Luganville, Efate', vanuatu)?.doc).toMatchObject({
      slug: 'efate',
    })
  })

  it('resolves the two-level addresses the legacy templates write', () => {
    expect(resolveLegacyLocation('Port Vila, Efate', vanuatu)?.doc).toMatchObject({
      slug: 'port-vila',
    })
    expect(
      resolveLegacyLocation('National University of Vanuatu, Santo, Vanuatu', vanuatu)?.doc,
    ).toMatchObject({ slug: 'espiritu-santo' })
    expect(resolveLegacyLocation('Anywhere/Work From Home', vanuatu)?.doc).toMatchObject({
      slug: 'anywhere-work-from-home',
    })
  })
})

describe('resolveLegacyLocations', () => {
  it('resolves several addresses in one label and de-duplicates them', () => {
    const { matched, unmatched } = resolveLegacyLocations(
      'Port Vila, Efate | Efate ; Atlantis',
      index,
    )

    expect(matched.map((match) => match.doc.id)).toEqual([2, 1])
    expect(unmatched).toEqual(['Atlantis'])
  })
})

describe('legacyAddressLabel', () => {
  it('prefers the picker pair and skips the island when the town repeats it', () => {
    expect(legacyAddressLabel({ _jr_geo_town: 'Port Vila', _jr_geo_region: 'Efate' })).toBe(
      'Port Vila, Efate',
    )
    // The picker writes `Overseas, Overseas` for the catch-all.
    expect(legacyAddressLabel({ _jr_geo_town: 'Overseas', _jr_geo_region: 'Overseas' })).toBe(
      'Overseas',
    )
  })

  it('falls back through the address keys', () => {
    expect(legacyAddressLabel({ _jr_geo_region: 'Efate' })).toBe('Efate')
    expect(legacyAddressLabel({ _jr_geo_town: 'Port Vila' })).toBe('Port Vila')
    expect(legacyAddressLabel({ _jr_geo_short_address: 'Port Vila, Efate' })).toBe(
      'Port Vila, Efate',
    )
    expect(legacyAddressLabel({ _jr_geo_address: 'Main Street, Santo' })).toBe('Main Street, Santo')
  })

  it('returns null when the post has no location meta', () => {
    expect(legacyAddressLabel({})).toBeNull()
    expect(legacyAddressLabel({ _jr_geo_short_address: '   ' })).toBeNull()
  })
})

describe('readLegacyLocationLabels', () => {
  it('groups posts by their location label, sorted, and reads no other meta', async () => {
    const connection = createFixtureConnection(taxonomyTables)
    // Page size 2 over four location meta rows: two full pages, then an empty last one.
    const reader = new MysqlReader({ connect: async () => connection, pageSize: 2 })

    const labels = await readLegacyLocationLabels(reader)

    expect(labels).toEqual([
      { label: 'Luganville, Espiritu Santo', postIds: [302] },
      { label: 'Main Street, Santo', postIds: [304] },
      { label: 'Nowhere, Atlantis', postIds: [303] },
      { label: 'Port Vila, Efate', postIds: [301] },
    ])

    const selects = connection.queries.filter((query) => query.startsWith('SELECT'))
    expect(selects).toHaveLength(3)
    expect(selects[0]).toMatch(/meta_key IN \(\?, \?, \?, \?\)/)
  })

  it('keys the query on every meta key the form can store a location in', async () => {
    const connection = createFixtureConnection(taxonomyTables)
    const reader = new MysqlReader({ connect: async () => connection })

    await readLegacyLocationLabels(reader)

    const select = connection.queries.find((query) => query.startsWith('SELECT'))
    // The keys travel as bound parameters, so the statement has one placeholder per key.
    expect(select).toContain(`meta_key IN (${LOCATION_META_KEYS.map(() => '?').join(', ')})`)
    expect(LOCATION_META_KEYS).toHaveLength(4)
  })
})

const harness = (locations: typeof locationDocs) =>
  createFakePayload({ locations: locations.map((doc) => ({ ...doc, tenant: 1 })) })

describe('locationsImporter', () => {
  it('writes nothing and skips the labels that match the tenant tree', async () => {
    const { payload, writes } = harness(locationDocs)
    const summary = await runImport({
      importers: [locationsImporter()],
      payload,
      reader: readerFor(),
      tenant: 1,
    })

    // `Nowhere, Atlantis` is the one gap in the fixtures.
    expect(summary.importers.locations).toMatchObject({ created: 0, failed: 1, skipped: 3, updated: 0 })
    expect(writes).toEqual([])
    expect(summary.errors[0]).toMatchObject({ importer: 'locations', message: expect.stringMatching(/Atlantis/) })
  })

  it('passes when every legacy label exists in the tenant', async () => {
    const tables = structuredClone(taxonomyTables)
    tables.wp_postmeta = tables.wp_postmeta!.filter((row) => row.post_id !== 303)

    const { payload, writes } = harness(locationDocs)
    const summary = await runImport({
      importers: [locationsImporter()],
      payload,
      reader: readerFor(tables),
      tenant: 1,
    })

    expect(summary.errors).toEqual([])
    expect(summary.importers.locations).toMatchObject({ created: 0, failed: 0, skipped: 3 })
    expect(writes).toEqual([])
  })

  it('treats another tenant’s tree as absent', async () => {
    const { payload } = createFakePayload({
      locations: locationDocs.map((doc) => ({ ...doc, tenant: 2 })),
    })
    const summary = await runImport({
      importers: [locationsImporter()],
      payload,
      reader: readerFor(),
      tenant: 1,
    })

    expect(summary.importers.locations).toMatchObject({ failed: 4, skipped: 0 })
  })

  it('names the posts in the failure, so a gap can be traced back', async () => {
    const { payload } = harness(locationDocs)
    const summary = await runImport({
      importers: [locationsImporter()],
      payload,
      reader: readerFor(),
      tenant: 1,
    })

    expect(summary.errors[0]!.message).toContain('post 303')
  })
})
