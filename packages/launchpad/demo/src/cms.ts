/**
 * An in-memory CMS for the demo build. It answers the two calls `loadJobListing` makes (`find`,
 * `findAll`) and evaluates the part of Payload's `where` syntax the listing emits, so the demo
 * page is produced by the real listing code: the same filters, the same live-jobs rule, the same
 * mapping. Only the transport is missing.
 *
 * This lives in the demo, not in `src/`: nothing a site ships should contain it.
 */
import type { CmsWhere } from '../../src/cms/types'

type Doc = Record<string, unknown> & { id: number | string }

export type DemoCollections = {
  'job-categories': Doc[]
  'job-types': Doc[]
  jobs: Doc[]
  locations: Doc[]
}

export type DemoFindOptions = {
  limit?: number
  page?: number
  sort?: string | string[]
  where?: CmsWhere
}

const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value])

/** A populated relationship is matched by its id, exactly as Payload would. */
const idOf = (value: unknown): unknown =>
  typeof value === 'object' && value !== null && 'id' in value ? (value as { id: unknown }).id : value

/** Dates compare as instants (`2026-11-19` is before `2026-11-19T10:49`), anything else as text. */
const compare = (actual: unknown, expected: unknown): number => {
  if (actual === undefined || actual === null) return Number.NaN
  const one = Date.parse(String(actual))
  const two = Date.parse(String(expected))

  return Number.isNaN(one) || Number.isNaN(two) ? String(actual).localeCompare(String(expected)) : one - two
}

const matches = (actual: unknown, operator: string, expected: unknown): boolean => {
  switch (operator) {
    case 'equals':
      return idOf(actual) === idOf(expected)
    case 'not_equals':
      return idOf(actual) !== idOf(expected)
    case 'in':
      return listed(actual).some((one) => listed(expected).some((want) => idOf(one) === idOf(want)))
    case 'not_in':
      return !listed(actual).some((one) => listed(expected).some((want) => idOf(one) === idOf(want)))
    case 'exists':
      return (actual !== undefined && actual !== null) === (expected === true || expected === 'true')
    case 'like':
      return typeof actual === 'string' && actual.toLowerCase().includes(String(expected).toLowerCase())
    case 'greater_than':
      return compare(actual, expected) > 0
    default:
      throw new Error(`demoCms: unsupported operator ${operator}`)
  }
}

const matchesWhere = (doc: Doc, where: CmsWhere | undefined): boolean => {
  if (!where) return true

  for (const [key, condition] of Object.entries(where)) {
    if (key === 'and') {
      if (!(condition as CmsWhere[]).every((one) => matchesWhere(doc, one))) return false
      continue
    }
    if (key === 'or') {
      if (!(condition as CmsWhere[]).some((one) => matchesWhere(doc, one))) return false
      continue
    }

    for (const [operator, value] of Object.entries(condition as Record<string, unknown>)) {
      if (!matches(doc[key], operator, value)) return false
    }
  }

  return true
}

const sortRows = (rows: Doc[], sort: string | string[] | undefined): Doc[] => {
  if (!sort) return rows
  const field = (Array.isArray(sort) ? sort[0]! : sort).replace(/^-/, '')
  if (field !== 'name') return rows

  return rows.toSorted((a, b) => String(a.name).localeCompare(String(b.name)))
}

/** A CMS over the demo's own rows. The listing cannot tell it from the real client. */
export const createDemoCms = (collections: DemoCollections) => ({
  findAll: async (collection: string, options?: { sort?: string }) =>
    sortRows(collections[collection as keyof DemoCollections] ?? [], options?.sort),

  find: async (collection: string, options: DemoFindOptions = {}) => {
    const rows = sortRows(
      (collections[collection as keyof DemoCollections] ?? []).filter((doc) => matchesWhere(doc, options.where)),
      options.sort,
    )
    const limit = options.limit && options.limit > 0 ? options.limit : Math.max(rows.length, 1)
    const totalPages = Math.max(1, Math.ceil(rows.length / limit))
    const page = Math.min(Math.max(options.page ?? 1, 1), totalPages)
    const from = (page - 1) * limit

    return {
      docs: rows.slice(from, from + limit),
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit,
      page,
      totalDocs: rows.length,
      totalPages,
    }
  },
})
