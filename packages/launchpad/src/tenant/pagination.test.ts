import { describe, expect, it } from 'vitest'

import { paginationModel, resultsSummary } from './pagination'

const href = (page: number): string => (page === 1 ? '/jobs' : `/jobs?page=${page}`)

const labels = (model: ReturnType<typeof paginationModel>): string =>
  model.items.map((item) => (item.kind === 'gap' ? '…' : item.label)).join(' ')

const pages = (totalPages: number, page = 1): string =>
  labels(paginationModel({ href, page, totalPages }))

describe('paginationModel', () => {
  it('shows one page and no links when there is one page', () => {
    const model = paginationModel({ href, page: 1, totalPages: 1 })

    expect(model.items).toEqual([{ current: true, kind: 'page', label: '1', page: 1 }])
    expect(model.previous).toBeNull()
    expect(model.next).toBeNull()
  })

  it('lists every page when they all fit', () => {
    expect(pages(5, 3)).toBe('1 2 3 4 5')
  })

  it('collapses the middle into a single gap on each side', () => {
    expect(pages(20, 10)).toBe('1 … 9 10 11 … 20')
  })

  it('shows no leading gap when the current page is near the start', () => {
    expect(pages(20, 2)).toBe('1 2 3 … 20')
  })

  it('shows no trailing gap when the current page is near the end', () => {
    expect(pages(20, 19)).toBe('1 … 18 19 20')
  })

  it('marks exactly one page as current', () => {
    const model = paginationModel({ href, page: 4, totalPages: 9 })
    const current = model.items.filter((item) => item.kind === 'page' && item.current)

    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ page: 4 })
  })

  it('links to the previous and next pages only when they exist', () => {
    expect(paginationModel({ href, page: 1, totalPages: 3 })).toMatchObject({
      next: { href: '/jobs?page=2', page: 2 },
      previous: null,
    })
    expect(paginationModel({ href, page: 2, totalPages: 3 })).toMatchObject({
      next: { href: '/jobs?page=3', page: 3 },
      previous: { href: '/jobs', page: 1 },
    })
    expect(paginationModel({ href, page: 3, totalPages: 3 }).next).toBeNull()
  })

  it('clamps a page number outside the range instead of rendering an empty list', () => {
    expect(paginationModel({ href, page: 99, totalPages: 4 }).page).toBe(4)
    expect(paginationModel({ href, page: 0, totalPages: 4 }).page).toBe(1)
    expect(paginationModel({ href, page: 3, totalPages: 0 }).totalPages).toBe(1)
  })

  it('honours wider siblings and edges', () => {
    expect(pages(20, 10)).toBe('1 … 9 10 11 … 20')
    expect(
      labels(paginationModel({ edges: 1, href, page: 10, siblings: 2, totalPages: 20 })),
    ).toBe('1 … 8 9 10 11 12 … 20')
  })
})

describe('resultsSummary', () => {
  it('says so when nothing matched', () => {
    expect(resultsSummary({ noun: 'jobs', page: 1, pageSize: 20, total: 0 })).toBe('No jobs found')
  })

  it('leaves out the range when everything fits on one page', () => {
    expect(resultsSummary({ noun: 'jobs', page: 1, pageSize: 20, total: 7 })).toBe('7 jobs')
  })

  it('gives the range on a later page, capped at the total', () => {
    expect(resultsSummary({ noun: 'jobs', page: 2, pageSize: 20, total: 137 })).toBe(
      'Showing 21–40 of 137 jobs',
    )
    expect(resultsSummary({ noun: 'jobs', page: 7, pageSize: 20, total: 137 })).toBe(
      'Showing 121–137 of 137 jobs',
    )
  })
})

describe('untrusted input', () => {
  it('falls back to page 1 for a non-numeric page from the URL', () => {
    const model = paginationModel({ href, page: Number.NaN, totalPages: 3 })

    expect(model.page).toBe(1)
    expect(model.previous).toBeNull()
    expect(model.next?.page).toBe(2)
  })

  it('clamps a page past the end, so a stale link still lists the last page', () => {
    expect(paginationModel({ href, page: 99, totalPages: 3 }).page).toBe(3)
  })

  it('never renders a negative or fractional page', () => {
    expect(paginationModel({ href, page: -5, totalPages: 3 }).page).toBe(1)
    expect(paginationModel({ href, page: 2.7, totalPages: 3 }).page).toBe(2)
  })

  it('sanitises the page in the results summary too', () => {
    expect(resultsSummary({ noun: 'jobs', page: Number.NaN, pageSize: 20, total: 137 })).toBe(
      'Showing 1–20 of 137 jobs',
    )
    expect(resultsSummary({ noun: 'jobs', page: 99, pageSize: 20, total: 137 })).toBe(
      'Showing 121–137 of 137 jobs',
    )
  })
})
