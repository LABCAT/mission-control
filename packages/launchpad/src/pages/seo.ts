/**
 * The head of a CMS page: title, description, robots and the sharing image. A page's `seo`
 * fields override its title, and an empty field falls back to the page itself, so a site manager
 * only fills in what differs from the default.
 */
import type { SiteTenant } from '../tenant/types'
import type { ContentPage } from './pathing'

export type PageMetadata = {
  description?: string
  image?: string
  noindex: boolean
  title: string
}

/** `About us | Vanuatu Wok`, unless the page's own SEO title says otherwise. */
export const pageTitle = (page: ContentPage, tenant: Pick<SiteTenant, 'name'>): string => {
  const own = page.seo && typeof page.seo === 'object' ? page.seo.title?.trim() : undefined
  if (own) return own

  const title = page.title.trim()
  const site = tenant.name.trim()
  if (!site || title.toLowerCase() === site.toLowerCase()) return title

  return `${title} | ${site}`
}

const imageUrl = (page: ContentPage): string | undefined => {
  const image = page.seo && typeof page.seo === 'object' ? page.seo.image : undefined
  if (!image || typeof image !== 'object') return undefined

  return image.url?.trim() || undefined
}

export const pageMetadata = (
  page: ContentPage,
  tenant: Pick<SiteTenant, 'name'>,
): PageMetadata => {
  const seo = page.seo && typeof page.seo === 'object' ? page.seo : undefined
  const description = seo?.description?.trim()
  const image = imageUrl(page)

  return {
    ...(description ? { description } : {}),
    ...(image ? { image } : {}),
    noindex: seo?.noIndex === true,
    title: pageTitle(page, tenant),
  }
}
