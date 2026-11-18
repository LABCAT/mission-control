import type { Importer } from './types'

/**
 * Importers the CLI can run, keyed by entity name. Each entity task (taxonomies, users,
 * media, jobs, ...) adds its importer here.
 */
export const registry: Record<string, Importer> = {}
