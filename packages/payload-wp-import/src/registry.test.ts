import { describe, expect, it } from 'vitest'

import { selectImporters, validateRegistry } from './cli'
import { registry } from './registry'
import { LEGACY_TAXONOMY_KEYS } from './importers/taxonomies'

describe('registry', () => {
  it('passes the CLI’s own validation', () => {
    expect(() => validateRegistry(registry)).not.toThrow()
  })

  it('offers every entity PJ-61, PJ-62 and PJ-64 import, plus the location audit', () => {
    expect(Object.keys(registry).toSorted()).toEqual(
      ['coupons', 'credits', 'job-categories', 'job-organisations', 'job-types', 'jobs', 'locations', 'orders', 'organisations', 'plans', 'salary-bands', 'users'].toSorted(),
    )
  })

  it('writes each taxonomy collection to itself', () => {
    for (const collection of Object.keys(LEGACY_TAXONOMY_KEYS)) {
      expect(registry[collection]?.collection, collection).toBe(collection)
    }
  })

  it('runs a taxonomy on its own, since none depends on another', () => {
    expect(selectImporters(registry, 'job-categories').map((importer) => importer.name)).toEqual([
      'job-categories',
    ])
  })

  it('runs everything for "all"', () => {
    expect(selectImporters(registry, 'all')).toHaveLength(Object.keys(registry).length)
  })
})
