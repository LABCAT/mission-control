import { describe, expect, it } from 'vitest'

const fieldMessages = (error: unknown): string =>
  ((error as { data?: { errors?: { message: string }[] } }).data?.errors ?? [])
    .map((fieldError) => fieldError.message)
    .join(' | ')

import { preventDeletingSystemPage, slugifyPageTitle, validatePageSlug } from './pages'
import { menuItemsValid, validateMenuUrl } from './menus'
import { SYSTEM_PAGE_CLEANUP_CONTEXT } from '../system-pages'

describe('page slugs', () => {
  it('derives a slug from the title', () => {
    expect(slugifyPageTitle('About Us!')).toBe('about-us')
    expect(slugifyPageTitle('  For   Employers  ')).toBe('for-employers')
    expect(slugifyPageTitle('Café Crème')).toBe('cafe-creme')
  })

  it('accepts lowercase hyphenated slugs and rejects anything else', () => {
    expect(validatePageSlug('about-us')).toBe(true)
    expect(validatePageSlug('')).toBe(true)
    expect(validatePageSlug(null)).toBe(true)
    expect(validatePageSlug('About Us')).toMatch(/lowercase letters/)
    expect(validatePageSlug('about_us')).toMatch(/lowercase letters/)
    expect(validatePageSlug('-about')).toMatch(/lowercase letters/)
  })

  it('refuses a slug longer than the cap', () => {
    expect(validatePageSlug('a'.repeat(121))).toMatch(/lowercase letters/)
  })
})

describe('menu item URLs', () => {
  it('accepts paths, anchors, absolute URLs and contact links', () => {
    for (const url of ['/jobs', '/organisations/vanuatu-brewing', '#main', '?page=2']) {
      expect(validateMenuUrl(url)).toBe(true)
    }
    for (const url of ['https://example.com', 'mailto:hello@example.com', 'tel:+6781234']) {
      expect(validateMenuUrl(url)).toBe(true)
    }
  })

  it('rejects an empty link and a dangerous scheme', () => {
    expect(validateMenuUrl('')).toMatch(/needs a link/)
    expect(validateMenuUrl(undefined)).toMatch(/needs a link/)
    expect(validateMenuUrl('javascript:alert(1)')).toMatch(/http, https, mailto or tel/)
    expect(validateMenuUrl('data:text/html,<script>')).toMatch(/http, https, mailto or tel/)
  })

  it('rejects a scheme hidden behind whitespace or control characters', () => {
    expect(validateMenuUrl('java\tscript:alert(1)')).toMatch(/http, https, mailto or tel/)
    expect(validateMenuUrl('  javascript:alert(1)')).toMatch(/http, https, mailto or tel/)
  })

  it('rejects protocol-relative URLs, which would leave the site', () => {
    expect(validateMenuUrl('//evil.example')).toMatch(/protocol-relative/)
    expect(validateMenuUrl('/\\evil.example')).toMatch(/protocol-relative/)
  })
})

describe('menu item tenant check', () => {
  // A REST update can move a menu to another site and leave the items out, so the stored page
  // links survive untouched. The hook must check those items against the new site.
  const run = async ({
    data,
    operation = 'update',
    originalItems,
  }: {
    data: Record<string, unknown>
    operation?: 'create' | 'update'
    originalItems?: unknown[]
  }) => {
    const pages: Record<string, unknown> = { 1: { id: 1, tenant: 1 }, 2: { id: 2, tenant: 2 } }
    const hook = menuItemsValid({ pagesSlug: 'pages' as never, tenantScoped: true })

    const request = {
      payload: {
        findByID: async ({ id }: { id: number }) => pages[id] ?? null,
      },
    }

    return hook({
      data,
      operation,
      originalDoc: { id: 9, items: originalItems, tenant: 1 },
      req: request,
    } as never)
  }

  it('checks the stored items when an update moves the menu and leaves them out @S-145', async () => {
    const error = await run({
      data: { tenant: 2 },
      originalItems: [{ label: 'About', linkType: 'page', page: 1 }],
    }).catch((caught: unknown) => caught)

    expect(fieldMessages(error)).toMatch(/belongs to another site/)
  })

  it('allows the move when the stored items already point at the new site @S-145', async () => {
    await expect(
      run({
        data: { tenant: 2 },
        originalItems: [{ label: 'About', linkType: 'page', page: 2 }],
      }),
    ).resolves.toBeDefined()
  })

  it('leaves the stored items alone when the tenant does not change @S-145', async () => {
    await expect(
      run({
        data: { name: 'Renamed' },
        originalItems: [{ label: 'About', linkType: 'page', page: 1 }],
      }),
    ).resolves.toBeDefined()
  })
})

describe('system page delete guard', () => {
  const run = async ({
    context,
    page,
  }: {
    context?: Record<string, unknown>
    page: Record<string, unknown> | null
  }) =>
    preventDeletingSystemPage('pages' as never)({
      id: 1,
      req: {
        context,
        payload: { findByID: async () => page },
      },
    } as never)

  it('refuses a role page even when its tenant is null', async () => {
    const error = await run({ page: { id: 1, role: 'contact', tenant: null } }).catch(
      (caught: unknown) => caught,
    )

    expect(fieldMessages(error)).toMatch(/unpublish it instead of deleting it/)
  })

  it('lets the tenant cleanup through', async () => {
    await expect(
      run({
        context: { [SYSTEM_PAGE_CLEANUP_CONTEXT]: true },
        page: { id: 1, role: 'contact', tenant: 3 },
      }),
    ).resolves.toBeUndefined()
  })

  it('lets an ordinary page be deleted', async () => {
    await expect(run({ page: { id: 1, role: null, tenant: 3 } })).resolves.toBeUndefined()
  })
})
