import type { MysqlReader } from './mysql-reader'

/** The subset of the Payload local API the framework needs. Real `Payload` satisfies it. */
export type ImportPayload = {
  create: (args: {
    collection: any
    data: any
    overrideAccess?: boolean
  }) => Promise<{ id: number | string }>
  find: (args: {
    collection: any
    depth?: number
    limit?: number
    overrideAccess?: boolean
    pagination?: boolean
    where?: any
  }) => Promise<{ docs: { id: number | string }[] }>
  update: (args: {
    collection: any
    data: any
    id: number | string
    overrideAccess?: boolean
  }) => Promise<unknown>
}

export type ImportContext = {
  dryRun: boolean
  payload: ImportPayload
  /** Tenant id every imported document is scoped to. */
  tenant: number | string
}

export type MappedDoc = {
  /** Fields for the collection. `legacyId` and the tenant are set by the runner. */
  data: Record<string, unknown>
  /** The WordPress primary key of the source row. */
  legacyId: number
}

export type Importer<Row = any> = {
  /** Slug of the Payload collection that receives the mapped documents. */
  collection: string
  /** Names of importers that must run first. */
  dependsOn: string[]
  /** Map one row. Return `null` to skip it. Throwing records a failure for this row only. */
  map: (row: Row, ctx: ImportContext) => MappedDoc | null | Promise<MappedDoc | null>
  name: string
  read: (reader: MysqlReader) => AsyncIterable<Row> | Iterable<Row>
}

export type ImportCounts = {
  created: number
  failed: number
  skipped: number
  updated: number
}

export type ImportFailure = {
  importer: string
  legacyId?: number
  message: string
}

export type ImporterResult = ImportCounts & {
  /** Set when the importer did not complete (read error or failed dependency). */
  aborted?: string
}

export type ImportSummary = {
  dryRun: boolean
  errors: ImportFailure[]
  /** Importers in the order they ran (or were attempted). */
  importers: Record<string, ImporterResult>
  order: string[]
}
