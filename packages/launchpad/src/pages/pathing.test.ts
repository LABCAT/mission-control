import { describe, expect, it } from 'vitest'

import {
  normalisePath,
  pagePath,
  pagePaths,
  resolveContentRoute,
  type ContentPage,
} from './pathing'

const page = (input: Partial<ContentPage> & { id: number | string; title: string }): ContentPage => input

const home = page({ id: 1, role: 'home', slug: null, title: 'Home' })
const about = page({ id: 2, parent: 1, slug: 'about', title: 'About us' })
const team = page({ id: 3, parent: 2, slug: 'team', title: 'Our team' })
const organisations = page({ id: 4, role: 'organisations', slug: 'organisations', title: 'Organisations' })
const jobs = page({ id: 5, slug: 'for-employers', title: 'For employers' })
const pages = [home, about, team, organisations, jobs]

describe('page paths', () => {
  it('serves the home page at / whatever its slug says @S-290', () => {
    expect(pagePath({ ...home, slug: 'ignored' }, pages)).toBe('/')
    expect(resolveContentRoute(pages, '/')).toEqual({ kind: 'page', page: home, path: '/' })
  })

  it('builds a nested path from the chain of slugs @S-291', () => {
    expect(pagePath(about, pages)).toBe('/about')
    expect(pagePath(team, pages)).toBe('/about/team')
    expect(pagePath(jobs, pages)).toBe('/for-employers')
  })

  it('keeps the organisations branch at /organisations @S-291', () => {
    expect(pagePath(organisations, pages)).toBe('/organisations')
  })

  it('has no address for a page whose parent is missing from the set', () => {
    expect(pagePath(page({ id: 9, parent: 99, slug: 'orphan', title: 'Orphan' }), pages)).toBeNull()
  })

  it('has no address for a page with no slug', () => {
    expect(pagePath(page({ id: 10, title: 'No slug' }), pages)).toBeNull()
  })

  it('treats the home page as the root of the chain, not a segment', () => {
    // The CMS refuses children of home (PJ-103); if one existed, its parent adds no segment.
    expect(pagePath(page({ id: 11, parent: 1, slug: 'direct', title: 'Direct' }), pages)).toBe('/direct')
  })

  it('resolves a parent that arrives as a populated document', () => {
    const populated = page({ id: 3, parent: { id: 2 } as ContentPage, slug: 'team', title: 'Our team' })

    expect(pagePath(populated, pages)).toBe('/about/team')
  })

  it('indexes every page by path and lets the first page keep a duplicate', () => {
    const byPath = pagePaths([...pages, page({ id: 12, slug: 'about', title: 'About (copy)' })])

    expect([...byPath.keys()].toSorted()).toEqual(['/', '/about', '/about/team', '/for-employers', '/organisations'])
    expect(byPath.get('/about')?.id).toBe(2)
  })
})

describe('request paths', () => {
  it('drops the query, a trailing slash and repeated slashes @S-291', () => {
    expect(normalisePath('/')).toBe('/')
    expect(normalisePath('/about/')).toBe('/about')
    expect(normalisePath('//about//team')).toBe('/about/team')
    expect(normalisePath('/about?utm_source=x')).toBe('/about')
  })

  it('decodes percent-escaped segments and keeps a malformed escape as typed', () => {
    expect(normalisePath('/caf%C3%A9')).toBe('/café')
    expect(normalisePath('/%E0%A4%A')).toBe('/%E0%A4%A')
  })
})

describe('content routes', () => {
  it('finds the page a path names, including a nested one @S-291', () => {
    expect(resolveContentRoute(pages, '/about/team')).toEqual({ kind: 'page', page: team, path: '/about/team' })
    expect(resolveContentRoute(pages, '/about/team/')).toMatchObject({ kind: 'page', path: '/about/team' })
  })

  it('answers not-found for an unknown path @S-292', () => {
    expect(resolveContentRoute(pages, '/nope')).toEqual({ kind: 'not-found' })
    expect(resolveContentRoute(pages, '/about/nope')).toEqual({ kind: 'not-found' })
  })
})
