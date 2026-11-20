import { describe, expect, it } from 'vitest'

import { MysqlReader } from '../mysql-reader'
import { runImport } from '../run-import'
import { createFakePayload } from '../test-utils'
import { createFixtureConnection, taxonomyTables } from '../test/fixtures'
import {
  LEGACY_TAXONOMY_KEYS,
  importableTerms,
  mapLegacyTerm,
  readTaxonomyTerms,
  taxonomyImporters,
  volunteerTermIDs,
} from './taxonomies'

const readerFor = (tables = taxonomyTables) => {
  const connection = createFixtureConnection(tables)
  return new MysqlReader({ connect: async () => connection, pageSize: 3 })
}

const legacyTerm = (
  overrides: Partial<Parameters<typeof mapLegacyTerm>[0]> = {},
): Parameters<typeof mapLegacyTerm>[0] => ({
  name: 'Full-Time',
  parent: 0,
  slug: 'full-time',
  taxonomy: 'job_type',
  term_id: 21,
  term_taxonomy_id: 201,
  ...overrides,
})

describe('readTaxonomyTerms', () => {
  it('reads only the requested taxonomy, and only terms that still exist', async () => {
    const terms = await readTaxonomyTerms(readerFor(), LEGACY_TAXONOMY_KEYS['job-categories'])

    // 701 points at a term row that is gone; the `category` term is another taxonomy.
    expect(terms.map((term) => term.term_id)).toEqual([11, 12, 13])
    expect(terms.every((term) => term.taxonomy === 'job_cat')).toBe(true)
  })

  it('reads every key of a taxonomy in one query', async () => {
    const connection = createFixtureConnection(taxonomyTables)
    const reader = new MysqlReader({ connect: async () => connection })

    const terms = await readTaxonomyTerms(reader, ['job_tag', 'job_tags'])

    expect(terms.map((term) => term.term_id).toSorted((a, b) => a - b)).toEqual([31, 32, 33])
    const selects = connection.queries.filter((query) => query.startsWith('SELECT'))
    expect(selects[0]).toMatch(/taxonomy IN \(\?, \?\)/)
  })

  it('does not read the terms table when the taxonomy has no rows', async () => {
    const connection = createFixtureConnection(taxonomyTables)
    const reader = new MysqlReader({ connect: async () => connection })

    expect(await readTaxonomyTerms(reader, 'no-such-taxonomy')).toEqual([])
    const selects = connection.queries.filter((query) => query.startsWith('SELECT'))
    expect(selects.every((query) => !query.includes('`wp_terms`'))).toBe(true)
  })
})

describe('volunteerTermIDs', () => {
  it('marks the Voluntary job type and its children, and nothing else', async () => {
    const terms = await readTaxonomyTerms(readerFor(), LEGACY_TAXONOMY_KEYS['job-types'])

    // 202 = Voluntary, 203 = Board position and 204 = Internship hang off it; 201 = Full-Time
    // and 205 = Not Stated do not.
    expect([...volunteerTermIDs(terms)].toSorted((a, b) => a - b)).toEqual([202, 203, 204])
  })

  it('stops at a parent loop in the legacy data instead of hanging', () => {
    const loop = [
      legacyTerm({ name: 'A', parent: 2, slug: 'a', term_id: 1, term_taxonomy_id: 301 }),
      legacyTerm({ name: 'B', parent: 1, slug: 'b', term_id: 2, term_taxonomy_id: 302 }),
    ]

    expect([...volunteerTermIDs(loop)]).toEqual([])
  })

  it('finds a volunteer ancestor two levels up', () => {
    const terms = [
      legacyTerm({ name: 'Voluntary', parent: 0, slug: 'voluntary', term_id: 1, term_taxonomy_id: 201 }),
      legacyTerm({ name: 'Board position', parent: 1, slug: 'board-position', term_id: 2, term_taxonomy_id: 202 }),
      legacyTerm({ name: 'Chair', parent: 2, slug: 'chair', term_id: 3, term_taxonomy_id: 203 }),
    ]

    expect([...volunteerTermIDs(terms)].toSorted((a, b) => a - b)).toEqual([201, 202, 203])
  })

  it('follows `parent` as a term id, which WordPress stores, not a term_taxonomy id', () => {
    // Every term is shared with another taxonomy, so the two id spaces are completely disjoint.
    const terms = [
      legacyTerm({ name: 'Voluntary', parent: 0, slug: 'voluntary', term_id: 10, term_taxonomy_id: 501 }),
      legacyTerm({ name: 'Board position', parent: 10, slug: 'board-position', term_id: 11, term_taxonomy_id: 502 }),
      legacyTerm({ name: 'Chair', parent: 11, slug: 'chair', term_id: 12, term_taxonomy_id: 503 }),
      legacyTerm({ name: 'Full-Time', parent: 0, slug: 'full-time', term_id: 20, term_taxonomy_id: 504 }),
    ]

    expect([...volunteerTermIDs(terms)].toSorted((a, b) => a - b)).toEqual([501, 502, 503])
  })
})

describe('importableTerms', () => {
  it('sanitises names and keeps the legacy term_id as legacyId', async () => {
    const terms = await readTaxonomyTerms(readerFor(), LEGACY_TAXONOMY_KEYS['job-categories'])
    const rows = importableTerms(terms)

    // Term 13 has nothing usable in its name or its slug: it stays in the list so the run
    // counts it as skipped, and the mapper refuses to write it.
    expect(rows.map((row) => [row.term_id, row.name, row.slug])).toEqual([
      [11, 'Hospitality &amp; Tourism', 'hospitality-tourism'],
      [12, 'Construction &amp; roading', 'construction-roading'],
      [13, '!!!', '!!!'],
    ])
  })

  it('keeps a term whose name and slug have nothing usable, for the mapper to skip', () => {
    const rows = importableTerms([legacyTerm({ name: '!!!', slug: '!!!' })])

    expect(rows).toHaveLength(1)
    expect(mapLegacyTerm(rows[0]!)).toBeNull()
  })

  it('gives colliding slugs a stable suffix from the term id', () => {
    const rows = importableTerms([
      legacyTerm({ name: 'Trades & Services', slug: 'trades-services', term_id: 32 }),
      legacyTerm({ name: 'Trades and services', slug: 'trades_&_services', term_id: 33 }),
    ])

    expect(rows.map((row) => row.slug)).toEqual(['trades-services', 'trades-services-33'])
  })

  it('adds the volunteer flag only when asked, so the other taxonomies stay unchanged', () => {
    const terms = [
      legacyTerm({ name: 'Voluntary', slug: 'voluntary', term_id: 22, term_taxonomy_id: 202 }),
      legacyTerm({ name: 'Chair', parent: 22, slug: 'chair', term_id: 23, term_taxonomy_id: 203 }),
    ]

    expect(importableTerms(terms).map((row) => row.isVolunteer)).toEqual([undefined, undefined])
    expect(
      importableTerms(terms, { withVolunteer: true }).map((row) => row.isVolunteer),
    ).toEqual([true, true])
  })
})

describe('mapLegacyTerm', () => {
  it('decodes the name and writes only the fields the collection has', () => {
    expect(mapLegacyTerm(legacyTerm({ name: 'Construction &amp; roading', slug: 'construction-roading' }))).toEqual({
      data: { name: 'Construction & roading', slug: 'construction-roading' },
      legacyId: 21,
    })
  })

  it('carries the volunteer flag when the term has one', () => {
    expect(mapLegacyTerm(legacyTerm({ isVolunteer: true }))?.data).toMatchObject({
      isVolunteer: true,
    })
  })

  it('skips a term that cannot produce a valid document', () => {
    expect(mapLegacyTerm(legacyTerm({ name: '   ', slug: '   ' }))).toBeNull()
    expect(mapLegacyTerm(legacyTerm({ name: '!!!', slug: '!!!' }))).toBeNull()
  })
})

describe('taxonomyImporters', () => {
  it('covers every taxonomy collection, with no dependencies between them', () => {
    const importers = taxonomyImporters()

    expect(importers.map((importer) => importer.collection)).toEqual(Object.keys(LEGACY_TAXONOMY_KEYS))
    expect(importers.every((importer) => importer.dependsOn.length === 0)).toBe(true)
    expect(importers.map((importer) => importer.name)).toEqual(Object.keys(LEGACY_TAXONOMY_KEYS))
  })

  it('imports the fixture taxonomies into their collections, idempotently', async () => {
    const { payload, store } = createFakePayload()
    const importers = taxonomyImporters()

    const first = await runImport({ importers, payload, reader: readerFor(), tenant: 1 })

    expect(first.errors).toEqual([])
    expect(first.importers['job-categories']).toMatchObject({ created: 2, failed: 0, skipped: 1 })
    expect(first.importers['job-types']).toMatchObject({ created: 5, failed: 0 })
    expect(first.importers['salary-bands']).toMatchObject({ created: 1, failed: 0 })

    const types = new Map(store['job-types']!.map((doc) => [doc.legacyId, doc]))
    expect(types.get(21)).toMatchObject({ isVolunteer: false, name: 'Full-Time', slug: 'full-time' })
    expect(types.get(22)).toMatchObject({ isVolunteer: true, name: 'Voluntary' })
    expect(types.get(23)).toMatchObject({ isVolunteer: true, name: 'Board position' })
    expect(types.get(24)).toMatchObject({ isVolunteer: true, name: 'Internship', slug: 'internship-voluntary' })
    expect(types.get(25)).toMatchObject({ isVolunteer: false, name: 'Not Stated' })

    expect(store['salary-bands']![0]).toMatchObject({ name: 'Vt 0 – 1,000,000', slug: '0-100000' })

    const second = await runImport({ importers, payload, reader: readerFor(), tenant: 1 })

    expect(second.errors).toEqual([])
    expect(second.importers['job-categories']).toMatchObject({ created: 0, updated: 2 })
    expect(second.importers['job-types']).toMatchObject({ created: 0, updated: 5 })
    expect(store['job-types']).toHaveLength(5)
  })

  it('keeps each tenant’s taxonomy separate', async () => {
    const { payload, store } = createFakePayload()
    const importers = taxonomyImporters()

    await runImport({ importers, payload, reader: readerFor(), tenant: 1 })
    await runImport({ importers, payload, reader: readerFor(), tenant: 2 })

    expect(store['job-categories']!.filter((doc) => doc.tenant === 1)).toHaveLength(2)
    expect(store['job-categories']!.filter((doc) => doc.tenant === 2)).toHaveLength(2)
  })

  it('skips damaged legacy terms instead of failing the taxonomy', async () => {
    const tables = structuredClone(taxonomyTables)
    // A term id MySQL returned as text cannot be a `legacyId`, so the term is skipped.
    tables.wp_terms = [...tables.wp_terms!, { term_id: 'abc', name: 'Broken', slug: 'broken' }]
    tables.wp_term_taxonomy = [
      ...tables.wp_term_taxonomy!,
      { term_taxonomy_id: 801, term_id: 'abc', taxonomy: 'job_cat', parent: 0, count: 0 },
    ]

    const { payload, store } = createFakePayload()
    const summary = await runImport({
      importers: taxonomyImporters(),
      payload,
      reader: readerFor(tables),
      tenant: 1,
    })

    expect(summary.errors).toEqual([])
    // Term 13 (`!!!`) is skipped; the row with a non-numeric term id never reaches the runner.
    expect(summary.importers['job-categories']).toMatchObject({ created: 2, failed: 0, skipped: 1 })
    expect(store['job-categories']!.map((doc) => doc.slug)).toEqual([
      'hospitality-tourism',
      'construction-roading',
    ])
  })
})
