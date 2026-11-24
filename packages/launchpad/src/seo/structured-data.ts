/**
 * schema.org structured data (JSON-LD), generated from content (PJ-104).
 *
 * Founder decision (19 Nov): one SEO tab, and the markup is generated from what the site already
 * knows. Nothing here reads a hand-typed JSON field: each node is built from the page, the tenant
 * and the documents already loaded, so editing content updates the markup.
 *
 * The generators are pure and return plain objects, so a page composes several into one `@graph`
 * and a test snapshots the result without a CMS. `JobPosting` lives in `../tenant/seo.ts`, next to
 * the job page that owns it, and is reused rather than restated here.
 *
 * Only indexable pages get a node: a `noindex` page (an expired job, a filtered listing, an
 * unpublished page) is left out, because markup describing a page the site asks crawlers to skip
 * contradicts the page itself.
 */
import type { JobDetailView } from '../jobs/detail'
import type { JobListingView } from '../jobs/listing'
import type { OrganisationProfile } from '../organisations/profile'
import type { PageView } from '../pages/view'
import { canonicalUrl } from '../tenant/seo'
import type { SiteTenant } from '../tenant/types'

export const SCHEMA_CONTEXT = 'https://schema.org'

export type JsonLdNode = Record<string, unknown>

/** A crumb as the theme holds it: a site-relative path, made absolute by the composer. */
export type Breadcrumb = { name: string; path: string }

const text = (value: null | string | undefined): string | undefined => value?.trim() || undefined

/**
 * An absolute URL for a site path, or `undefined` when the deployment has no canonical origin. A
 * relative `url` is not valid JSON-LD, so the property is dropped rather than guessed.
 */
const absolute = (siteUrl: null | string | undefined, path: string): string | undefined =>
  text(siteUrl) ? canonicalUrl(siteUrl, path) : undefined

/** A node without its `@context`, for nesting inside another node. */
const withoutContext = (node: JsonLdNode): JsonLdNode => {
  const { '@context': _context, ...rest } = node

  return rest
}

/**
 * One script's worth of JSON-LD. A page with several entities gets a single `@graph`, which
 * Google recommends over several `ld+json` blocks; a lone node keeps its own `@context`.
 */
export const jsonLdDocument = (nodes: readonly JsonLdNode[]): JsonLdNode => {
  const list = nodes.filter((node) => node && Object.keys(node).length > 0)
  if (list.length === 1) return list[0]!

  return { '@context': SCHEMA_CONTEXT, '@graph': list.map(withoutContext) }
}

export type OrganizationInput = {
  description?: null | string
  logo?: null | string
  name: string
  /** Profile URLs, e.g. the organisation's Facebook page. Blank entries are dropped. */
  sameAs?: readonly (null | string)[] | null
  url?: null | string
}

/** An `Organization` node without `@context`, so a page can nest it as `about` or `publisher`. */
export const organizationNode = ({
  description,
  logo,
  name,
  sameAs,
  url,
}: OrganizationInput): JsonLdNode => {
  const profiles = (sameAs ?? [])
    .map((value) => text(value))
    .filter((value): value is string => Boolean(value))

  return {
    '@type': 'Organization',
    name: name.trim(),
    ...(text(url) ? { url: text(url) } : {}),
    ...(text(logo) ? { logo: text(logo) } : {}),
    ...(text(description) ? { description: text(description) } : {}),
    ...(profiles.length > 0 ? { sameAs: profiles } : {}),
  }
}

export type WebSiteInput = {
  description?: null | string
  name: string
  /** The listing path that answers `?q=`. Defaults to `/jobs`. */
  searchPath?: null | string
  siteUrl?: null | string
}

/**
 * The site itself, with the search action a search engine shows under the site name. The
 * `urlTemplate` only appears when the site has a canonical origin, since an `EntryPoint` cannot
 * be relative.
 */
export const webSiteStructuredData = ({
  description,
  name,
  searchPath = '/jobs',
  siteUrl,
}: WebSiteInput): JsonLdNode => {
  const search = text(searchPath)
  const template = search ? absolute(siteUrl, search) : undefined
  const url = absolute(siteUrl, '/')

  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'WebSite',
    name: name.trim(),
    ...(url ? { url } : {}),
    ...(text(description) ? { description: text(description) } : {}),
    ...(template
      ? {
          potentialAction: {
            '@type': 'SearchAction',
            'query-input': 'required name=search_term_string',
            target: { '@type': 'EntryPoint', urlTemplate: `${template}?q={search_term_string}` },
          },
        }
      : {}),
  }
}

/**
 * The trail from the site root to the page. A single crumb is not a trail (Google rejects it),
 * and a crumb with no origin cannot be named, so one or none returns `null`.
 */
export const breadcrumbStructuredData = (
  crumbs: readonly Breadcrumb[],
  siteUrl?: null | string,
): JsonLdNode | null => {
  const items = crumbs
    .map((crumb) => ({ name: text(crumb.name), url: absolute(siteUrl, crumb.path) }))
    .filter((item): item is { name: string; url: string } => Boolean(item.name && item.url))
  if (items.length < 2) return null

  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}

/** Which schema.org type a content page is. A system page gets the more specific subtype. */
export const PAGE_SCHEMA_TYPES = ['WebPage', 'AboutPage', 'ContactPage', 'CollectionPage'] as const
export type PageSchemaType = (typeof PAGE_SCHEMA_TYPES)[number]

export type PageNodeInput = {
  about?: OrganizationInput
  description?: null | string
  /** The list the page shows, for a `CollectionPage`. */
  mainEntity?: JsonLdNode | null
  name: string
  type?: PageSchemaType
  url?: null | string
}

/** A page node: `WebPage` unless the page's role gives it a more specific type. */
export const pageStructuredData = ({
  about,
  description,
  mainEntity,
  name,
  type = 'WebPage',
  url,
}: PageNodeInput): JsonLdNode => ({
  '@context': SCHEMA_CONTEXT,
  '@type': type,
  name: name.trim(),
  ...(text(url) ? { url: text(url) } : {}),
  ...(text(description) ? { description: text(description) } : {}),
  ...(about ? { about: organizationNode(about) } : {}),
  ...(mainEntity ? { mainEntity: withoutContext(mainEntity) } : {}),
})

export type ItemListEntry = { name: string; path: string }

export type ItemListInput = {
  items: readonly ItemListEntry[]
  name?: null | string
  path?: null | string
  siteUrl?: null | string
}

/**
 * A list of links: the jobs on a listing page, the organisations in the directory, or an
 * organisation's own jobs. An empty list returns `null`: advertising zero items is noise, and a
 * list with no origin cannot name absolute URLs.
 */
export const itemListStructuredData = ({
  items,
  name,
  path,
  siteUrl,
}: ItemListInput): JsonLdNode | null => {
  const entries = items
    .map((item) => ({ name: text(item.name), url: absolute(siteUrl, item.path) }))
    .filter((item): item is { name: string; url: string } => Boolean(item.name && item.url))
  if (entries.length === 0) return null

  return {
    '@context': SCHEMA_CONTEXT,
    '@type': 'ItemList',
    ...(text(name) ? { name: text(name) } : {}),
    ...(absolute(siteUrl, path ?? '/') ? { url: absolute(siteUrl, path ?? '/') } : {}),
    numberOfItems: entries.length,
    itemListElement: entries.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      url: entry.url,
    })),
  }
}

/** The schema.org type a content page's role gives it. */
export const pageType = (role: null | string | undefined): PageSchemaType => {
  if (role === 'about') return 'AboutPage'
  if (role === 'contact') return 'ContactPage'
  if (role === 'organisations') return 'CollectionPage'

  return 'WebPage'
}

export type ContentPageStructuredDataInput = {
  /** Absolute origin of this deployment. Without one the URLs cannot be named, so nodes drop. */
  siteUrl?: null | string
  tenant: SiteTenant
  /** The breadcrumb trail, from the home page to this one. */
  trail: readonly Breadcrumb[]
  view: PageView
}

/**
 * A CMS page: its own node, the site, and the trail. A `noindex` page gets nothing at all, which
 * is the same rule that keeps it out of the sitemap.
 */
export const contentPageStructuredData = ({
  siteUrl,
  tenant,
  trail,
  view,
}: ContentPageStructuredDataInput): JsonLdNode | null => {
  if (view.metadata.noindex) return null

  const site = webSiteStructuredData({ name: tenant.name, siteUrl })
  const node = pageStructuredData({
    about: { name: tenant.name },
    description: view.metadata.description,
    name: view.metadata.title,
    type: pageType(view.page.role),
    url: absolute(siteUrl, view.path),
  })
  const breadcrumbs = breadcrumbStructuredData(trail, siteUrl)

  return jsonLdDocument([site, node, ...(breadcrumbs ? [breadcrumbs] : [])])
}

export type ListingStructuredDataInput = {
  /** Absolute origin of this deployment. */
  siteUrl?: null | string
  /** The page's title, which is also the `CollectionPage` name. */
  title: string
  description?: null | string
  /** The section's trail, e.g. `Home → Jobs → Hospitality`. */
  trail: readonly Breadcrumb[]
  tenant: SiteTenant
  view: JobListingView
}

/**
 * A listing page: a `CollectionPage` whose main entity is the jobs it shows. A filtered or paged
 * listing is a variant of the section, so it carries nothing: the unfiltered section already says
 * what the board is, and a filtered page is `noindex`.
 */
export const listingStructuredData = ({
  description,
  siteUrl,
  tenant,
  title,
  trail,
  view,
}: ListingStructuredDataInput): JsonLdNode | null => {
  if (view.hasActiveFilters || view.page > 1) return null

  const path = trail.at(-1)?.path ?? '/jobs'
  const list = itemListStructuredData({
    items: view.jobs.map((job) => ({ name: job.title, path: job.url })),
    name: title,
    path,
    siteUrl,
  })
  const node = pageStructuredData({
    description,
    mainEntity: list,
    name: title,
    type: 'CollectionPage',
    url: absolute(siteUrl, path),
  })
  const breadcrumbs = breadcrumbStructuredData(trail, siteUrl)

  return jsonLdDocument([
    webSiteStructuredData({ name: tenant.name, siteUrl }),
    node,
    ...(breadcrumbs ? [breadcrumbs] : []),
  ])
}

export type OrganisationStructuredDataInput = {
  /** Absolute origin of this deployment. */
  siteUrl?: null | string
  profile: OrganisationProfile
  tenant: SiteTenant
}

/**
 * An organisation page: the organisation itself, its live jobs as a list, and the trail. A
 * private organisation has no page at all, and a noindex one asks not to be indexed, so there
 * is nothing to describe.
 */
export const organisationStructuredData = ({
  profile,
  siteUrl,
  tenant,
}: OrganisationStructuredDataInput): JsonLdNode | null => {
  // A noindex organisation carries no structured data, like a noindex page or job (S-349).
  if (profile.seoNoIndex === true) return null

  const path = `/organisations/${encodeURIComponent(profile.slug)}`
  const site = webSiteStructuredData({ name: tenant.name, siteUrl })
  const organisation = {
    '@context': SCHEMA_CONTEXT,
    ...organizationNode({
      description: profile.about,
      logo: profile.logo?.url,
      name: profile.name,
      url: profile.website ?? absolute(siteUrl, path),
    }),
  }
  const jobs = itemListStructuredData({
    items: profile.jobs.map((job) => ({ name: job.title, path: job.url })),
    name: `Jobs at ${profile.name}`,
    path,
    siteUrl,
  })
  const breadcrumbs = breadcrumbStructuredData(
    [
      { name: 'Home', path: '/' },
      { name: 'Organisations', path: '/organisations' },
      { name: profile.name, path },
    ],
    siteUrl,
  )

  return jsonLdDocument([site, organisation, ...(jobs ? [jobs] : []), ...(breadcrumbs ? [breadcrumbs] : [])])
}

export type JobStructuredDataInput = {
  /** Absolute origin of this deployment. */
  siteUrl?: null | string
  view: JobDetailView
}

/**
 * A job page: the `JobPosting` the detail module already builds for a live job, plus the trail
 * and the site. A closed job keeps the page but loses the posting, exactly as the page itself
 * does, and so emits nothing.
 */
export const jobStructuredData = ({ siteUrl, view }: JobStructuredDataInput): JsonLdNode | null => {
  if (!view.jsonLd) return null

  const breadcrumbs = breadcrumbStructuredData(
    [
      { name: 'Home', path: '/' },
      { name: 'Jobs', path: '/jobs' },
      { name: view.detail.title, path: view.detail.url },
    ],
    siteUrl,
  )

  return jsonLdDocument([view.jsonLd as JsonLdNode, ...(breadcrumbs ? [breadcrumbs] : [])])
}
