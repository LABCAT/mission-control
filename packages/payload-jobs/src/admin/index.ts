export * from './collections'
export * from './dashboard'
export * from './links'
export * from './nav'

export type { SiteManagerNavOptions as SiteManagerAdminOptions } from './nav'

/** The package name the admin import map resolves components from. */
export const PACKAGE_NAME = '@mission-control/payload-jobs'

/** Import-map path for the site manager dashboard (PJ-30). */
export const DASHBOARD_COMPONENT_PATH = `${PACKAGE_NAME}/rsc#SiteManagerDashboard`
