/**
 * The collection slugs a site reads its content from. Payload Jobs resolves its slugs from the
 * plugin options (PJ-80), so a host may rename `pages`, `menus` or `jobs`; a site passes the
 * resolved slugs here instead of the theme assuming the defaults.
 */
export type SiteCollections = {
  jobs: string
  menus: string
  pages: string
}

/** The slugs a mission-control installation uses unless its CMS config renames them. */
export const DEFAULT_SITE_COLLECTIONS: SiteCollections = {
  jobs: 'jobs',
  menus: 'menus',
  pages: 'pages',
}

/** The site's slugs, with any it does not name left at the default. */
export const siteCollections = (overrides?: Partial<SiteCollections>): SiteCollections => ({
  ...DEFAULT_SITE_COLLECTIONS,
  ...overrides,
})
