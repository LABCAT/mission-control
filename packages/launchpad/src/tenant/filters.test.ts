import { describe, expect, it } from 'vitest'

import {
  filterQuery,
  hasActiveFilters,
  hiddenFilterFields,
  humaniseFilterValue,
  parseFilters,
  type FilterDefinition,
} from './filters'

const definitions: FilterDefinition[] = [
  { name: 'q' },
  { name: 'category', allowed: ['trades', 'hospitality'] },
  { name: 'location', allowed: ['port-vila', 'luganville'] },
  { name: 'page' },
]

describe('parseFilters', () => {
  it('keeps known parameters and drops everything else', () => {
    const values = parseFilters(
      'q=carpenter&category=trades&utm_source=newsletter&evil=%3Cscript%3E',
      definitions,
    )

    expect(values).toEqual({ category: 'trades', q: 'carpenter' })
  })

  it('drops values outside the allowed list, so a hand-edited URL cannot inject a filter', () => {
    expect(parseFilters('category=ceo&location=port-vila', definitions)).toEqual({
      location: 'port-vila',
    })
  })

  it('drops blank values and whitespace', () => {
    expect(parseFilters('q=%20%20&category=', definitions)).toEqual({})
  })

  it('accepts URLSearchParams as well as a raw string', () => {
    expect(parseFilters(new URLSearchParams('q=driver'), definitions)).toEqual({ q: 'driver' })
  })

  it('takes the first value when a parameter repeats', () => {
    expect(parseFilters('q=driver&q=cook', definitions)).toEqual({ q: 'driver' })
  })

  it('returns nothing for an empty search', () => {
    expect(parseFilters('', definitions)).toEqual({})
    expect(parseFilters(null, definitions)).toEqual({})
  })
})

describe('filterQuery', () => {
  it('orders parameters as the form does, so the same filters make the same URL', () => {
    expect(filterQuery({ page: '2', q: 'cook', category: 'trades' }, definitions)).toBe(
      'q=cook&category=trades&page=2',
    )
  })

  it('is the inverse of parseFilters for valid values', () => {
    const search = 'q=cook&category=trades'
    expect(filterQuery(parseFilters(search, definitions), definitions)).toBe(search)
  })

  it('omits empty and disallowed values', () => {
    expect(filterQuery({ category: 'ceo', location: '', q: '  ' }, definitions)).toBe('')
  })

  it('escapes values that need it', () => {
    expect(filterQuery({ q: 'chef & baker' }, definitions)).toBe('q=chef+%26+baker')
  })
})

describe('hasActiveFilters', () => {
  it('ignores blank values', () => {
    expect(hasActiveFilters({ q: '' })).toBe(false)
    expect(hasActiveFilters({ q: '  ' })).toBe(false)
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters({ q: 'cook' })).toBe(true)
  })
})

describe('hiddenFilterFields', () => {
  it('carries the other filters and never the page, which the link owns', () => {
    expect(
      hiddenFilterFields({ category: 'trades', page: '3', q: 'cook' }, definitions),
    ).toEqual([
      { name: 'q', value: 'cook' },
      { name: 'category', value: 'trades' },
    ])
  })
})

describe('humaniseFilterValue', () => {
  it('turns a slug into a label', () => {
    expect(humaniseFilterValue('full-time')).toBe('Full time')
    expect(humaniseFilterValue('port_vila')).toBe('Port vila')
    expect(humaniseFilterValue('trades')).toBe('Trades')
  })
})
