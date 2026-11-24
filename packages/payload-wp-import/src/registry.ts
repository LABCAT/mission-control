import { commerceImporters } from './importers/commerce'
import { jobsImporters } from './importers/jobs'
import { locationsImporter } from './importers/locations'
import { menusImporter } from './importers/menus'
import { pagesImporter } from './importers/pages'
import { siteSettingsImporter } from './importers/site-settings'
import { taxonomyImporters } from './importers/taxonomies'
import { createPlanProvider, usersImporters } from './importers/users'
import type { Importer } from './types'

/**
 * Importers the CLI can run, keyed by entity name. Each entity task adds its importer here.
 *
 * `locations` audits the legacy job locations against the tenant's own tree; it writes nothing.
 * The taxonomies import into the five `payload-jobs` taxonomy collections. `organisations` and
 * `users` (PJ-62) import the active legacy users and the organisations derived from the employers.
 * `job-organisations` and `jobs` (PJ-64) import the published and expired jobs.
 * `plans` (checks the seed), `coupons`, `orders` (last 24 months) and `credits` (opening balances)
 * are PJ-65.
 * `site-settings`, `pages` and `menus` (PJ-67) import the site chrome, the content pages and the
 * three menus; `pages` adopts the system pages the tenant seed created.
 */
const planProvider = createPlanProvider()
export const registry: Record<string, Importer> = Object.fromEntries(
  [
    locationsImporter(),
    ...taxonomyImporters(),
    ...Object.values(usersImporters({ planProvider })),
    ...Object.values(jobsImporters({ planProvider })),
    ...Object.values(commerceImporters({ planProvider })),
    siteSettingsImporter(),
    pagesImporter(),
    menusImporter(),
  ].map((importer) => [importer.name, importer]),
)

