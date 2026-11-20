// Type-only: the generated Payload types are the single source of truth for documents.
import type { Config } from '../../../../apps/cms/src/payload-types'

export type CmsCollections = Config['collections']
export type CmsGlobals = Config['globals']

export type CmsCollectionSlug = keyof CmsCollections & string
export type CmsGlobalSlug = keyof CmsGlobals & string

export type CmsDoc<K extends CmsCollectionSlug> = CmsCollections[K]
export type CmsGlobal<K extends CmsGlobalSlug> = CmsGlobals[K]

/** Payload REST list response. */
export type CmsList<T> = {
  docs: T[]
  hasNextPage: boolean
  hasPrevPage: boolean
  limit: number
  page: number
  totalDocs: number
  totalPages: number
}

export type CmsWhereOperator =
  | 'equals'
  | 'not_equals'
  | 'in'
  | 'not_in'
  | 'all'
  | 'contains'
  | 'like'
  | 'exists'
  | 'greater_than'
  | 'greater_than_equal'
  | 'less_than'
  | 'less_than_equal'

export type CmsWhere = {
  and?: CmsWhere[]
  or?: CmsWhere[]
} & {
  // Field conditions. `and`/`or` above are the only reserved keys.
  [field: string]: unknown
}

export type CmsQuery = {
  /** Relationship depth. Payload's default applies when omitted. */
  depth?: number
  draft?: boolean
  locale?: string
  /** Field selection, e.g. `{ title: true }`. */
  select?: Record<string, unknown>
  /** Field name, `-` prefix for descending. */
  sort?: string | string[]
  where?: CmsWhere
}

export type CmsFindOptions = CmsQuery & {
  limit?: number
  page?: number
}
