import { locationsImporter } from './importers/locations'
import { taxonomyImporters } from './importers/taxonomies'
import type { Importer } from './types'

/**
 * Importers the CLI can run, keyed by entity name. Each entity task adds its importer here.
 *
 * `locations` audits the legacy job locations against the tenant's own tree; it writes nothing.
 * The taxonomies import into the five `payload-jobs` taxonomy collections.
 */
export const registry: Record<string, Importer> = Object.fromEntries(
  [locationsImporter(), ...taxonomyImporters()].map((importer) => [importer.name, importer]),
)

