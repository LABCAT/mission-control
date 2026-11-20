import type { Config, GlobalConfig } from 'payload'
import { describe, expect, it } from 'vitest'

import type { MissionControlUser } from '../access'
import {
  isSiteManager,
  SITE_MANAGER_NAV_COLLECTIONS,
  siteManagerVisibleCollections,
  withSiteManagerNav,
} from './nav'

const SLUGS = ['jobs', 'organisations', 'orders', 'plans', 'tenants', 'site-keys', 'users', 'documents']

const config = {
  collections: SLUGS.map((slug) => ({ slug, fields: [] })),
  globals: [{ slug: 'system-status', fields: [] } as unknown as GlobalConfig],
} as unknown as Config

const siteManagerA: MissionControlUser = {
  id: 1,
  role: 'user',
  tenants: [{ role: 'tenant-admin', tenant: 10 }],
}
const siteManagerB: MissionControlUser = {
  id: 2,
  role: 'user',
  tenants: [{ role: 'tenant-admin', tenant: 20 }],
}
const editorA: MissionControlUser = { id: 3, role: 'user', tenants: [{ role: 'editor', tenant: 10 }] }
const superAdmin: MissionControlUser = { id: 4, role: 'super-admin', tenants: [] }
const employer: MissionControlUser = { id: 5, role: 'user', tenants: [{ role: 'employer', tenant: 10 }] }
const seeker: MissionControlUser = { id: 6, role: 'user', tenants: [{ role: 'seeker', tenant: 10 }] }

const globalsFor = (target: Config, user: MissionControlUser): string[] =>
  (target.globals ?? [])
    .filter((global) => {
      const hidden = global.admin?.hidden
      return typeof hidden === 'function' ? !hidden({ user: user as never }) : !hidden
    })
    .map((global) => global.slug)

describe('site manager nav @S-117', () => {
  it('treats tenant admins and editors as site managers, and nobody else', () => {
    expect(isSiteManager(siteManagerA)).toBe(true)
    expect(isSiteManager(editorA)).toBe(true)
    expect(isSiteManager(superAdmin)).toBe(false)
    expect(isSiteManager(employer)).toBe(false)
    expect(isSiteManager(seeker)).toBe(false)
    expect(isSiteManager(null)).toBe(false)
  })

  it('shows a site manager the tenant content and hides platform collections', () => {
    const trimmed = withSiteManagerNav(config)

    expect(siteManagerVisibleCollections(trimmed, siteManagerA)).toEqual([
      'jobs',
      'organisations',
      'orders',
      'plans',
      'users',
      'documents',
    ])
    expect(siteManagerVisibleCollections(trimmed, siteManagerB)).toEqual(
      siteManagerVisibleCollections(trimmed, siteManagerA),
    )
  })

  it('leaves a super admin’s nav exactly as the host built it', () => {
    const trimmed = withSiteManagerNav(config)

    expect(siteManagerVisibleCollections(config, superAdmin)).toEqual(SLUGS)
    expect(siteManagerVisibleCollections(trimmed, superAdmin)).toEqual(SLUGS)
  })

  it('leaves employers and seekers with the host’s nav, since they never use the admin', () => {
    const trimmed = withSiteManagerNav(config)

    expect(siteManagerVisibleCollections(trimmed, employer)).toEqual(SLUGS)
    expect(siteManagerVisibleCollections(trimmed, seeker)).toEqual(SLUGS)
  })

  it('hides platform globals from a site manager and keeps them for a super admin', () => {
    const trimmed = withSiteManagerNav(config)

    expect(globalsFor(trimmed, siteManagerA)).toEqual([])
    expect(globalsFor(trimmed, superAdmin)).toEqual(['system-status'])
  })

  it('keeps an entity’s own `hidden` decision instead of overriding it', () => {
    const alreadyHidden = {
      collections: [{ slug: 'jobs', fields: [], admin: { hidden: true } }, { slug: 'users', fields: [] }],
      globals: [],
    } as unknown as Config

    const trimmed = withSiteManagerNav(alreadyHidden)

    expect(siteManagerVisibleCollections(trimmed, superAdmin)).toEqual(['users'])
    expect(siteManagerVisibleCollections(trimmed, siteManagerA)).toEqual(['users'])
  })

  it('treats a throwing `hidden` function as hidden, as Payload does', () => {
    const throwing = {
      collections: [
        { slug: 'jobs', fields: [], admin: { hidden: () => { throw new Error('boom') } } },
        { slug: 'users', fields: [] },
      ],
      globals: [],
    } as unknown as Config

    expect(siteManagerVisibleCollections(withSiteManagerNav(throwing), superAdmin)).toEqual(['users'])
  })

  it('honours an explicit allow-list from the host', () => {
    const trimmed = withSiteManagerNav(config, { collections: ['jobs'], globals: ['system-status'] })

    expect(siteManagerVisibleCollections(trimmed, siteManagerA)).toEqual(['jobs'])
    expect(siteManagerVisibleCollections(trimmed, superAdmin)).toEqual(SLUGS)
  })

  it('keeps the task’s own list of collections in the default allow-list', () => {
    for (const slug of [
      'jobs',
      'organisations',
      'orders',
      'applications',
      'pages',
      'plans',
      'coupons',
      'add-ons',
      // The tenant content S-120 and S-119 need in the menu.
      'locations',
      'job-categories',
      'job-types',
      'salary-bands',
      'media',
      'documents',
      'folders',
      'tags',
      'users',
    ]) {
      expect(SITE_MANAGER_NAV_COLLECTIONS).toContain(slug)
    }
    // Platform collections must never appear in a site manager's menu.
    for (const slug of ['tenants', 'site-keys']) {
      expect(SITE_MANAGER_NAV_COLLECTIONS).not.toContain(slug)
    }
    // Removed in PJ-80; naming them would be a stale entry that hides nothing.
    for (const slug of ['job-tags', 'areas-of-focus']) {
      expect(SITE_MANAGER_NAV_COLLECTIONS).not.toContain(slug)
    }
  })
})
