import { describe, expect, it } from 'vitest'

import { footerMenuItems, loadFooterMenu, pagePath } from './footer-menu'

describe('pagePath', () => {
  it('builds the path a page is served at @S-310', () => {
    expect(pagePath({ slug: 'about' })).toBe('/about')
    expect(pagePath({ slug: '/about/' })).toBe('/about')
  })

  it('serves the home page at the root, which has no slug @S-310', () => {
    expect(pagePath({ role: 'home', slug: null })).toBe('/')
  })

  it('returns null when the page cannot be addressed @S-310', () => {
    expect(pagePath(null)).toBeNull()
    expect(pagePath(undefined)).toBeNull()
    // Depth 0 returns an id, not a slug: the footer cannot build a link from it.
    expect(pagePath(7)).toBeNull()
    expect(pagePath({ slug: null })).toBeNull()
    expect(pagePath({ slug: '  ' })).toBeNull()
  })
})

describe('footerMenuItems @S-310', () => {
  it('maps a footer menu in the order the site manager arranged it @S-310', () => {
    const items = footerMenuItems({
      items: [
        { label: 'About us', page: { slug: 'about' } },
        { label: 'Contact us', url: '/contact' },
        { label: 'YCV', url: 'https://ycv.vu' },
      ],
    })

    expect(items).toEqual([
      { label: 'About us', url: '/about' },
      { label: 'Contact us', url: '/contact' },
      { label: 'YCV', url: 'https://ycv.vu' },
    ])
  })

  it('prefers a custom URL over the linked page @S-310', () => {
    expect(
      footerMenuItems({ items: [{ label: 'Privacy', page: { slug: 'privacy' }, url: '/legal/privacy' }] }),
    ).toEqual([{ label: 'Privacy', url: '/legal/privacy' }])
  })

  it('keeps a label whose page it cannot address, so the text is never lost @S-310', () => {
    expect(footerMenuItems({ items: [{ label: 'Orphan', page: 12 }] })).toEqual([{ label: 'Orphan' }])
  })

  it('drops items without a label and handles a missing menu @S-310', () => {
    expect(footerMenuItems({ items: [{ url: '/jobs' }] })).toEqual([])
    expect(footerMenuItems(null)).toEqual([])
    expect(footerMenuItems({ items: null })).toEqual([])
  })
})

describe('loadFooterMenu @S-310', () => {
  it('reads the footer menu, with its pages populated, and maps its items @S-310', async () => {
    const calls: unknown[] = []
    const cms = {
      findAll: async (collection: string, query: unknown) => {
        calls.push({ collection, query })

        return [
          {
            items: [
              { label: 'About us', page: { id: 4, slug: 'about' }, url: null },
              { label: 'YCV', page: null, url: 'https://ycv.vu' },
            ],
            location: 'footer',
          },
        ]
      },
    }

    await expect(loadFooterMenu(cms as never, { locale: 'bi' })).resolves.toEqual([
      { label: 'About us', url: '/about' },
      { label: 'YCV', url: 'https://ycv.vu' },
    ])
    // The page relationship has to be populated, or its slug is not there to build a link from.
    expect(calls[0]).toMatchObject({
      collection: 'menus',
      query: { depth: 1, locale: 'bi', where: { location: { equals: 'footer' } } },
    })
  })

  it('returns no items when the site has no footer menu @S-310', async () => {
    const cms = { findAll: async () => [] }

    await expect(loadFooterMenu(cms as never)).resolves.toEqual([])
  })
})
