import type { SiteManagerNavOptions } from './nav'

export * from './dashboard'
export * from './links'
export * from './nav'

/**
 * What a host sets on `siteManagerAdmin`: the allow-list overrides. The resolved slugs come
 * from the plugin's own options (PJ-80), so a host never repeats them here.
 */
export type SiteManagerAdminOptions = Pick<SiteManagerNavOptions, 'collections' | 'globals'>

/** The package name the admin import map resolves components from. */
export const PACKAGE_NAME = '@mission-control/payload-jobs'

/** Import-map path for the site manager dashboard (PJ-30). */
export const DASHBOARD_COMPONENT_PATH = `${PACKAGE_NAME}/rsc#SiteManagerDashboard`
