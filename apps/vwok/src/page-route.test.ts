import { describe, expect, it } from 'vitest'

import type { CmsClient } from '@mission-control/launchpad/cms'

import { pageRoute } from './page-route'

const pages = [
  { id: 1, layout: [{ blockType: 'hero', heading: 'FIND A JOB IN VANUATU' }], role: 'home', title: 'Home' },
  { id: 2, parent: 1, slug: 'about', title: 'About us', layout: [{ blockType: 'rich-text' }] },
  { id: 3, parent: 2, slug: 'team', title: 'Our team', layout: [] },
]

const menus = [
  {
    id: 1,
    items: [{ label: 'About us', linkType: 'page', page: 2 }],
    location: 'primary',
    name: 'Main',
  },
]

const cms = {
  findAll: async (collection: string) => (collection === 'pages' ? pages : menus) as never,
  find: async () => ({ docs: [], totalDocs: 0 }) as never,
} as unknown as CmsClient

describe('page route', () => {
  it('renders the home page at / by its role, whatever its slug @S-290', async () => {
    const route = await pageRoute({ cms, pathname: '/' })

    expect(route.kind).toBe('page')
    if (route.kind !== 'page') return
    expect(route.view.page.title).toBe('Home')
    expect(route.view.segments).toHaveLength(1)
  })

  it('renders a nested page at /<parent>/<slug> @S-291', async () => {
    const route = await pageRoute({ cms, pathname: '/about/team' })

    expect(route.kind).toBe('page')
    if (route.kind !== 'page') return
    expect(route.view.path).toBe('/about/team')
    expect(route.view.page.title).toBe('Our team')
    expect(route.menus[0]?.links).toEqual([{ href: '/about', label: 'About us', newTab: false }])
  })

  it('is a 404 for an unknown path, and still carries the menus @S-292', async () => {
    const route = await pageRoute({ cms, pathname: '/missing' })

    expect(route.kind).toBe('not-found')
    if (route.kind !== 'not-found') return
    expect(route.menus).toHaveLength(1)
  })

  it('serves only / from the shell when the CMS is not configured @S-290', async () => {
    expect(await pageRoute({ cms: null, pathname: '/' })).toEqual({ kind: 'shell' })
    expect(await pageRoute({ cms: null, pathname: '/about' })).toEqual({ kind: 'not-found', menus: [] })
  })
})

