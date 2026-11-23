/**
 * Menus (PJ-103) as the theme renders them: top bar, primary navigation and footer. A menu item
 * either names a page of this site, whose address comes from the page tree, or a URL the editor
 * typed. Resolving both here keeps the renderer free of lookup logic and of unsafe hrefs.
 */
import type { ContentPage } from './pathing'
import { pagePath } from './pathing'

/** Where the theme shows a menu. Each site has at most one menu per location. */
export const MENU_LOCATIONS = ['top', 'primary', 'footer'] as const

export type MenuLocation = (typeof MENU_LOCATIONS)[number]

/** A Payload `menus` document, at any depth of relationship population. */
export type ContentMenu = {
  id: number | string
  items?:
    | null
    | {
        label?: null | string
        linkType?: null | string
        newTab?: null | boolean
        page?: { id: number | string } | null | number | string
        url?: null | string
      }[]
  location: string
  name?: null | string
}

export type MenuLink = {
  href: string
  label: string
  newTab: boolean
}

export type MenuView = {
  label: string
  links: MenuLink[]
  location: MenuLocation
}

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

/**
 * The href when it is a destination a public page may link to, otherwise `null`. Relative paths,
 * anchors and queries are the normal case; absolute `http(s)`, `mailto` and `tel` links are
 * allowed. A `javascript:` value would be stored XSS on every page, so it is refused here as well
 * as in the collection's validator.
 */
export const safeMenuHref = (value: null | string | undefined): null | string => {
  const trimmed = value?.trim()
  if (!trimmed) return null

  // Browsers ignore whitespace and control characters inside a scheme, so strip them first.
  const compact = [...trimmed]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code > 0x20 && !(code >= 0x7f && code <= 0x9f)
    })
    .join('')
    .toLowerCase()
    .replace(/\\/g, '/')

  if (compact.startsWith('//')) return null
  if (compact.startsWith('/') || compact.startsWith('#') || compact.startsWith('?')) return trimmed

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]
  return scheme && ALLOWED_SCHEMES.has(scheme) ? trimmed : null
}

const refID = (value: unknown): null | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return String((value as { id: number | string }).id)
  return String(value)
}

const locationLabel: Record<MenuLocation, string> = {
  footer: 'Footer',
  primary: 'Primary',
  top: 'Top bar',
}

const isLocation = (value: string): value is MenuLocation =>
  (MENU_LOCATIONS as readonly string[]).includes(value)

/**
 * Turn the site's menus into what the header and footer render. A page item's href is the page's
 * current path, so renaming a slug moves the link too; an item pointing at a page that is not
 * live, or at a URL the CMS would not accept, is dropped rather than rendered as a broken link.
 *
 * Unknown locations are ignored: a menu the theme has no place for must not appear twice.
 */
export const menuViews = (
  menus: readonly ContentMenu[],
  pages: readonly ContentPage[] = [],
): MenuView[] => {
  const byID = new Map(pages.map((page) => [String(page.id), page]))
  const seen = new Set<string>()
  const views: MenuView[] = []

  for (const menu of menus) {
    if (!isLocation(menu.location) || seen.has(menu.location)) continue
    seen.add(menu.location)

    const links: MenuLink[] = []
    for (const item of menu.items ?? []) {
      const label = item.label?.trim()
      if (!label) continue

      const href =
        item.linkType === 'page'
          ? (() => {
              const id = refID(item.page)
              const page = id === null ? null : byID.get(id)
              return page ? pagePath(page, pages) : null
            })()
          : safeMenuHref(item.url)

      if (!href) continue

      links.push({
        href,
        label,
        // A link to another site opens in a new tab unless the editor said otherwise.
        newTab: item.newTab === true,
      })
    }

    views.push({
      label: menu.name?.trim() || locationLabel[menu.location],
      links,
      location: menu.location,
    })
  }

  return views
}

/** The links for one location, in display order. An absent menu is an empty list. */
export const menuFor = (menus: readonly MenuView[], location: MenuLocation): MenuLink[] =>
  menus.find((menu) => menu.location === location)?.links ?? []
