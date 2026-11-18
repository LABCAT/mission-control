import type { MysqlReader } from '../mysql-reader'
import { legacySlug, legacySlugPart, legacyText } from '../legacy-text'
import type { Importer, MappedDoc } from '../types'

/**
 * Import of the JobRoller taxonomies into the `payload-jobs` collections. WordPress keeps every
 * term in `wp_terms`, and its taxonomy, hierarchy and count in `wp_term_taxonomy`; the links
 * from posts to terms are in `wp_term_relationships` and belong to the job importer (PJ-64).
 */

/**
 * Payload collection → the `wp_term_taxonomy.taxonomy` keys it is imported from. The names come
 * from AUDIT.md (`job_cat`, `job_type`, `job_tag`, `job_salary`, the `area-of-focus` user
 * taxonomy). Each list has the underscore and dash spellings JobRoller versions use; a wrong
 * guess yields no rows rather than wrong data, and the run reports the empty importer.
 */
export const LEGACY_TAXONOMY_KEYS = {
  'areas-of-focus': ['area-of-focus', 'area_of_focus', 'areas-of-focus', 'areas_of_focus'],
  'job-categories': ['job_cat', 'job_categories'],
  'job-tags': ['job_tag', 'job_tags'],
  'job-types': ['job_type', 'job_types'],
  'salary-bands': ['job_salary', 'job_salaries'],
} as const

export type TaxonomyCollection = keyof typeof LEGACY_TAXONOMY_KEYS

/** One `wp_terms` row joined with its `wp_term_taxonomy` row. */
export type LegacyTerm = {
  name: string
  /** `wp_term_taxonomy.parent`: the parent's `term_taxonomy_id`, `0` for a root term. */
  parent: number
  slug: string
  taxonomy: string
  /** `wp_terms.term_id`, which becomes the collection's `legacyId`. */
  term_id: number
  term_taxonomy_id: number
}

/** A term with the slug it will be imported under and, for job types, its volunteer flag. */
export type ImportableTerm = LegacyTerm & { isVolunteer?: boolean }

export const VOLUNTEER_TAXONOMY_SLUG = 'voluntary'

/** Every term of one taxonomy, in `term_taxonomy_id` order so a run is repeatable. */
export const readTaxonomyTerms = async (
  reader: MysqlReader,
  taxonomyKeys: string | readonly string[],
): Promise<LegacyTerm[]> => {
  const keys = Array.isArray(taxonomyKeys) ? taxonomyKeys : [taxonomyKeys]
  if (keys.length === 0) return []

  const where =
    keys.length === 1 ? 'taxonomy = ?' : `taxonomy IN (${keys.map(() => '?').join(', ')})`
  const taxonomies: Record<string, unknown>[] = []
  for await (const row of reader.rows('term_taxonomy', {
    key: 'term_taxonomy_id',
    params: [...keys],
    where,
  })) {
    taxonomies.push(row)
  }

  // This taxonomy has no terms: don't read the whole terms table for nothing.
  if (taxonomies.length === 0) return []

  const terms = new Map<number, { name: string; slug: string }>()
  for await (const row of reader.rows<Record<string, unknown>>('terms', { key: 'term_id' })) {
    terms.set(Number(row.term_id), { name: String(row.name ?? ''), slug: String(row.slug ?? '') })
  }

  const found: LegacyTerm[] = []
  for (const row of taxonomies) {
    const termId = Number(row.term_id)
    const term = Number.isInteger(termId) ? terms.get(termId) : undefined
    // A term_taxonomy row whose `wp_terms` row is gone, or whose id is not a number, is legacy
    // damage; skipping it keeps it out of the import instead of failing the taxonomy.
    if (!term) continue

    found.push({
      name: term.name,
      parent: Number(row.parent ?? 0),
      slug: term.slug,
      taxonomy: String(row.taxonomy ?? ''),
      term_id: termId,
      term_taxonomy_id: Number(row.term_taxonomy_id),
    })
  }

  return found
}

const isVolunteerRoot = (term: LegacyTerm): boolean =>
  legacySlugPart(term.slug) === VOLUNTEER_TAXONOMY_SLUG ||
  legacySlugPart(term.name) === VOLUNTEER_TAXONOMY_SLUG

/**
 * The `term_taxonomy_id`s of the volunteer job type and everything below it. AUDIT.md defines a
 * volunteer job as the "Voluntary" job type or one of its child terms, and the Payload
 * collections keep no parent relation, so the ancestry is resolved here from the legacy tree.
 * A parent loop in the legacy data ends the walk instead of hanging.
 */
export const volunteerTermIDs = (terms: readonly LegacyTerm[]): Set<number> => {
  const byId = new Map(terms.map((term) => [term.term_taxonomy_id, term]))
  const volunteers = new Set<number>()

  for (const term of terms) {
    const visited = new Set<number>()
    let current: LegacyTerm | undefined = term

    while (current && !visited.has(current.term_taxonomy_id)) {
      if (isVolunteerRoot(current) || volunteers.has(current.term_taxonomy_id)) {
        volunteers.add(term.term_taxonomy_id)
        break
      }

      visited.add(current.term_taxonomy_id)
      current = current.parent > 0 ? byId.get(current.parent) : undefined
    }
  }

  return volunteers
}

/**
 * Terms ready to import. The slug stays as the legacy site had it unless another term of the
 * same taxonomy already sanitises to that slug (a few legacy slugs differ only in punctuation).
 * The later term gets its `term_id` appended — stable across runs — so the upsert by `legacyId`
 * stays idempotent and no term trips the `(tenant, slug)` unique index.
 */
export const importableTerms = (
  terms: readonly LegacyTerm[],
  { withVolunteer = false }: { withVolunteer?: boolean } = {},
): ImportableTerm[] => {
  const volunteers = withVolunteer ? volunteerTermIDs(terms) : undefined
  const used = new Set<string>()
  const rows: ImportableTerm[] = []

  for (const term of terms) {
    // A term with no usable slug is kept: the mapper skips it and the run counts it as skipped,
    // which tells the operator more than dropping it here would.
    const base = legacySlug(term.slug, term.name)
    const slug = base ? (used.has(base) ? `${base}-${term.term_id}` : base) : term.slug
    used.add(slug)

    const row: ImportableTerm = { ...term, slug }
    if (volunteers) row.isVolunteer = volunteers.has(term.term_taxonomy_id)
    rows.push(row)
  }

  return rows
}

/** A term as a taxonomy document, or `null` when it has nothing usable to import. */
export const mapLegacyTerm = (term: ImportableTerm): MappedDoc | null => {
  const name = legacyText(term.name)
  // `importableTerms` has already resolved slug collisions, so its slug wins when it is valid.
  const slug = legacySlug(term.slug, term.name)
  if (!name || !slug) return null
  // A term id MySQL returned as anything but a number cannot be a `legacyId`; skip the term.
  if (!Number.isInteger(term.term_id) || term.term_id <= 0) return null

  const data: Record<string, unknown> = { name, slug }
  if (typeof term.isVolunteer === 'boolean') data.isVolunteer = term.isVolunteer

  return { data, legacyId: term.term_id }
}

/**
 * One importer per taxonomy collection, in the order the plugin declares them. Job types read
 * the whole taxonomy up front because the volunteer flag needs the ancestry; the others stream
 * page by page. The term tables are small (tens of rows per taxonomy).
 */
export const taxonomyImporters = (): Importer<ImportableTerm>[] =>
  (Object.keys(LEGACY_TAXONOMY_KEYS) as TaxonomyCollection[]).map((collection) => ({
    collection,
    dependsOn: [],
    map: mapLegacyTerm,
    name: collection,
    read: async function* (reader) {
      const terms = await readTaxonomyTerms(reader, LEGACY_TAXONOMY_KEYS[collection])
      for (const term of importableTerms(terms, { withVolunteer: collection === 'job-types' })) {
        yield term
      }
    },
  }))
