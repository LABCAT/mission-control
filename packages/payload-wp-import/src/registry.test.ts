import { describe, expect, it } from 'vitest'

import { selectImporters, validateRegistry } from './cli'
import { sortImporters } from './run-import'
import { registry } from './registry'
import { LEGACY_TAXONOMY_KEYS } from './importers/taxonomies'

describe('registry', () => {
  it('passes the CLI’s own validation', () => {
    expect(() => validateRegistry(registry)).not.toThrow()
  })

  it('offers every entity PJ-61, PJ-62, PJ-64 and PJ-67 import, plus the location audit', () => {
    expect(Object.keys(registry).toSorted()).toEqual(
      [
        'job-categories',
        'job-organisations',
        'job-types',
        'jobs',
        'locations',
        'menus',
        'organisations',
        'pages',
        'salary-bands',
        'site-settings',
        'users',
      ].toSorted(),
    )
  })

  it('runs the menus after the pages they link to', () => {
    expect(sortImporters(selectImporters(registry, 'menus')).map((importer) => importer.name)).toEqual([
      'pages',
      'menus',
    ])
  })

  it('runs the site settings and pages on their own', () => {
    expect(selectImporters(registry, 'site-settings').map((importer) => importer.name)).toEqual([
      'site-settings',
    ])
    expect(selectImporters(registry, 'pages').map((importer) => importer.name)).toEqual(['pages'])
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
