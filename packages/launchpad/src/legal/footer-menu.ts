/**
 * The site footer's menu (PJ-89, S-310). A site app reads the footer menu from the CMS and hands
 * its items to `SiteFooter` through this mapping, which turns a page relationship into the path
 * that page is served at, so the footer shows links rather than labels. A page the CMS returned
 * without its slug (depth 0) cannot be addressed, so it keeps the label alone.
 */
import type { CmsClient } from '../cms/client'
import type { LegalMenuItem } from './links'

type MenuPage = { role?: null | string; slug?: null | string } | number | string

export type FooterMenuItemDoc = {
  label?: null | string
  linkType?: null | string
  page?: MenuPage | null
  url?: null | string
}

export type FooterMenuDoc = { items?: FooterMenuItemDoc[] | null } | null | undefined

/** The path a page is served at: `/` for the home page, `/about` for a page with that slug. */
export const pagePath = (page: MenuPage | null | undefined): null | string => {
  if (page === null || page === undefined) return null
  if (typeof page !== 'object') return null

  // The home page is served at the root and has no slug (PJ-103).
  if (page.role === 'home') return '/'

  const slug = page.slug?.trim()
  if (slug === undefined || slug === '') return null

  return `/${slug.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

/**
 * The footer menu's items, in the order the site manager arranged them. `url` wins when the item
 * is a custom link; otherwise the linked page's path is used, and an item whose page cannot be
 * addressed keeps no `url` at all.
 */
export const footerMenuItems = (menu: FooterMenuDoc): LegalMenuItem[] =>
  (menu?.items ?? []).flatMap((item) => {
    const label = item.label?.trim()
    if (!label) return []

    const url = item.url?.trim()
    if (url) return [{ label, url }]

    const path = pagePath(item.page)

    return [{ label, ...(path === null ? {} : { url: path }) }]
  })

/**
 * Load the site's footer menu from the CMS. A site may have several footer menus (one per
 * language, say); the first in the CMS's order is the one the footer renders. A site with no
 * footer menu still gets the legal links, because `SiteFooter` always adds them.
 */
export const loadFooterMenu = async (
  cms: Pick<CmsClient, 'findAll'>,
  options: { locale?: string } = {},
): Promise<LegalMenuItem[]> => {
  const menus = await cms.findAll('menus', {
    depth: 1,
    ...(options.locale ? { locale: options.locale } : {}),
    where: { location: { equals: 'footer' } },
  })

  return footerMenuItems(menus[0] as FooterMenuDoc)
}
