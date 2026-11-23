import { describe, expect, it } from 'vitest'

import { menuFor, menuViews, safeMenuHref, type ContentMenu } from './menus'
import type { ContentPage } from './pathing'

const home: ContentPage = { id: 1, role: 'home', title: 'Home' }
const about: ContentPage = { id: 2, parent: 1, slug: 'about', title: 'About us' }
const team: ContentPage = { id: 3, parent: 2, slug: 'team', title: 'Our team' }
const pages = [home, about, team]

const menu = (input: Partial<ContentMenu> & { location: string }): ContentMenu => ({
  id: input.location,
  name: input.location,
  ...input,
})

describe('menus', () => {
  it('resolves a page item to the page current path, so renaming a slug moves the link @S-295', () => {
    const views = menuViews(
      [
        menu({
          items: [{ label: 'About', linkType: 'page', page: 2 }, { label: 'Team', linkType: 'page', page: 3 }],
          location: 'primary',
        }),
      ],
      pages,
    )

    expect(menuFor(views, 'primary')).toEqual([
      { href: '/about', label: 'About', newTab: false },
      { href: '/about/team', label: 'Team', newTab: false },
    ])
  })

  it('keeps a custom URL and its new-tab flag, and refuses an unsafe one @S-295', () => {
    const views = menuViews(
      [
        menu({
          items: [
            { label: 'Jobs', linkType: 'custom', url: '/jobs' },
            { label: 'YCV', linkType: 'custom', url: 'https://ycv.vu', newTab: true },
            { label: 'Bad', linkType: 'custom', url: 'javascript:alert(1)' },
          ],
          location: 'footer',
        }),
      ],
      pages,
    )

    expect(menuFor(views, 'footer')).toEqual([
      { href: '/jobs', label: 'Jobs', newTab: false },
      { href: 'https://ycv.vu', label: 'YCV', newTab: true },
    ])
  })

  it('drops an item whose page is not live, rather than linking nowhere @S-295', () => {
    const views = menuViews(
      [menu({ items: [{ label: 'Gone', linkType: 'page', page: 99 }], location: 'top' })],
      pages,
    )

    expect(menuFor(views, 'top')).toEqual([])
  })

  it('shows one menu per location and ignores a location the theme has no place for @S-296', () => {
    const views = menuViews(
      [
        menu({ items: [{ label: 'First', linkType: 'custom', url: '/one' }], location: 'primary' }),
        menu({ items: [{ label: 'Second', linkType: 'custom', url: '/two' }], location: 'primary' }),
        menu({ items: [{ label: 'Elsewhere', linkType: 'custom', url: '/x' }], location: 'sidebar' }),
      ],
      pages,
    )

    expect(views).toHaveLength(1)
    expect(menuFor(views, 'primary').map((link) => link.label)).toEqual(['First'])
  })

  it('names a menu the editor left unnamed after its location @S-296', () => {
    const views = menuViews([{ id: 9, items: [], location: 'footer', name: '  ' }], pages)

    expect(views[0]?.label).toBe('Footer')
  })
})

describe('safe menu hrefs', () => {
  it('allows relative paths, anchors, queries, http(s), mailto and tel', () => {
    for (const href of ['/jobs', '#main', '?q=chef', 'https://ycv.vu', 'http://x.test', 'mailto:a@b.test', 'tel:+678']) {
      expect(safeMenuHref(href)).toBe(href)
    }
  })

  it('refuses a scheme a public page must not link to', () => {
    for (const href of ['javascript:alert(1)', ' JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.test', '']) {
      expect(safeMenuHref(href)).toBeNull()
    }
    expect(safeMenuHref(undefined)).toBeNull()
  })
})
