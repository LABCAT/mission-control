import { jobsImporters } from './importers/jobs'
import { locationsImporter } from './importers/locations'
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
 */
const planProvider = createPlanProvider()
export const registry: Record<string, Importer> = Object.fromEntries(
  [
    locationsImporter(),
    ...taxonomyImporters(),
    ...Object.values(usersImporters({ planProvider })),
    ...Object.values(jobsImporters({ planProvider })),
  ].map((importer) => [importer.name, importer]),
)

