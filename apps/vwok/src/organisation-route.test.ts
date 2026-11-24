import { describe, expect, it } from 'vitest'

import type { CmsClient } from '@mission-control/launchpad/cms'

import { organisationRoute } from './organisation-route'

const santo = { id: 5, name: 'Santo Bakery', slug: 'santo-bakery' }

const cmsWith = (public_: Record<string, unknown>) => {
  const reads: string[] = []
  const cms = {
    find: async (collection: string) => {
      reads.push(collection)
      return { docs: [], totalDocs: 0 } as never
    },
    findAll: async () => [] as never,
    findBySlug: async (_collection: string, slug: string) => (public_[slug] ?? null) as never,
  } as unknown as CmsClient
  return { cms, reads }
}

describe('organisation route (PJ-38)', () => {
  it('shows a public organisation @S-224', async () => {
    const { cms } = cmsWith({ 'santo-bakery': santo })
    const route = await organisationRoute({ cms, slug: 'santo-bakery' })

    expect(route.kind).toBe('found')
    expect(route.kind === 'found' && route.profile.name).toBe('Santo Bakery')
  })

  it('is a 404 for an organisation the CMS does not return, with no job lookup @S-224', async () => {
    const { cms, reads } = cmsWith({ 'santo-bakery': santo })

    expect((await organisationRoute({ cms, slug: 'private-co' })).kind).toBe('not-found')
    expect(reads).not.toContain('jobs')
  })

  it('is a 404 when no CMS is configured @S-224', async () => {
    expect(await organisationRoute({ cms: null, slug: 'santo-bakery' })).toEqual({
      kind: 'not-found',
      menus: [],
    })
  })
})
