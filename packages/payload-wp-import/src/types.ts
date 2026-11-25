import type { MysqlReader } from './mysql-reader'

/** The subset of the Payload local API the framework needs. Real `Payload` satisfies it. */
export type ImportPayload = {
  /**
   * The Payload config, so a `rawCreate` can wrap localized fields. Real `payload.config`
   * satisfies it; without it nothing is wrapped (localization off).
   */
  config?: {
    collections?: { fields: any[]; slug: string }[]
    localization?: false | { defaultLocale: string }
  }
  /**
   * The database adapter. Needed only by importers that create documents with `rawCreate`.
   * Real `payload.db` satisfies it.
   */
  db?: { create: (args: { collection: any; data: any }) => Promise<{ id: number | string }> }
  create: (args: {
    collection: any
    /** Request context for the collection's hooks (see `MappedDoc.createContext`). */
    context?: Record<string, unknown>
    data: any
    overrideAccess?: boolean
  }) => Promise<{ id: number | string }>
  find: (args: {
    collection: any
    depth?: number
    limit?: number
    overrideAccess?: boolean
    pagination?: boolean
    showHiddenFields?: boolean
    where?: any
  }) => Promise<{ docs: ({ id: number | string } & Record<string, any>)[] }>
  update: (args: {
    collection: any
    /** Request context for the collection's hooks (see `MappedDoc.updateContext`). */
    context?: Record<string, unknown>
    data: any
    id: number | string
    overrideAccess?: boolean
  }) => Promise<unknown>
}

export type ImportContext = {
  dryRun: boolean
  /** Sync run: `refreshWhileSet` fields are applied. */
  refreshCredentials?: boolean
  payload: ImportPayload
  /** Tenant id every imported document is scoped to. */
  tenant: number | string
}

export type MappedDoc = {
  /**
   * Fields written only when the document is created, never on a re-run. For values that
   * change after the import, such as a password that the user has since set.
   */
  createOnly?: Record<string, unknown>
  /**
   * Create the document through the database adapter, skipping hooks, validation and defaults,
   * so every field must be given. For users: a collection hook would clear the legacy password
   * hash the moment a password is set, and the account has no password until its owner signs
   * in. Updates still go through `payload.update`.
   */
  rawCreate?: boolean
  /**
   * Hook context passed to `payload.create`. For a hook that guards a field the import must
   * set once, such as a coupon's use count.
   */
  createContext?: Record<string, unknown>
  /**
   * Hook context passed to `payload.update` on a re-run. For a hook that guards a field the
   * import must set, such as the job view counter.
   */
  updateContext?: Record<string, unknown>
  /**
   * Sync only (`refreshCredentials`). Fields rewritten on a re-run while the document still holds
   * a value for them, and only when the new value is set and different. For a legacy password
   * hash: it follows the WordPress password until the user signs in, which clears it, and is
   * never brought back after that.
   */
  refreshWhileSet?: Record<string, unknown>
  /** Fields for the collection. `legacyId` and the tenant are set by the runner. */
  data: Record<string, unknown>
  /** The WordPress primary key of the source row. */
  legacyId: number
}

/** A row the importer chose not to import. The reason is counted in the summary. */
export type SkippedRow = {
  /**
   * The row's `legacyId`, so a sync knows it was seen. Without it a skipped row blocks pruning
   * for the importer: the run cannot tell whether the row is the one an earlier run imported.
   */
  legacyId?: number
  /**
   * With `legacyId`: the row is skipped for a data problem, not because it left the site, so a
   * document an earlier run imported for it must stay. Without it, that document may be taken off the site.
   */
  keep?: boolean
  skip: string
}

export type Importer<Row = any> = {
  /** Slug of the Payload collection that receives the mapped documents. */
  collection: string
  /**
   * Find a document that already exists under another key than `legacyId`. Tried after the
   * `legacyId` lookup misses, so it runs once per document: the page importer adopts the
   * system page a site was seeded with (home, about, contact, organisations) instead of
   * creating a second one, and writes `legacyId` onto it for the next run.
   */
  findExisting?: (
    args: { ctx: ImportContext; data: Record<string, unknown>; legacyId: number },
  ) => Promise<{ id: number | string } | undefined>
  /** Names of importers that must run first. */
  dependsOn: string[]
  /**
   * Sync only. Policy for documents of this importer that carry a `legacyId` in the run's tenant
   * but whose row is no longer in the source. Returns the update that takes the document off the
   * site (unpublish / archive), or `undefined` when it already is. Documents are never hard-deleted.
   * No policy, no removal handling: orders, ledgers and users have none. Not allowed on an importer
   * that adopts existing documents (`findExisting`) or has no `legacyId` (`matchBy`).
   */
  removal?: (doc: Record<string, any>) => Record<string, unknown> | undefined
  /**
   * Map one row. Return `null` to skip it, or `{ skip: reason }` to skip it and count the reason.
   * Throwing records a failure for this row only.
   */
  map: (
    row: Row,
    ctx: ImportContext,
  ) => MappedDoc | null | SkippedRow | Promise<MappedDoc | null | SkippedRow>
  name: string
  read: (reader: MysqlReader) => AsyncIterable<Row> | Iterable<Row>
  /** Extra counts for the summary (rows read, merged, ...), called once the importer has run. */
  report?: () => Record<string, number>
  /**
   * For an append-only collection with no `legacyId` field (the credit ledger). Existing rows
   * are matched on `field` (value from the mapped data) plus the tenant instead of `legacyId`;
   * the runner does not write `legacyId`; and a row that exists is left alone (counted as
   * skipped, reason `already-imported`) because the collection refuses updates.
   */
  matchBy?: { field: string }
  /**
   * Where the tenant lives on the collection. Default: the runner's `tenantField`, a plain
   * field the runner sets. Users keep it in a `tenants` array, so they use
   * `{ path: 'tenants.tenant', set: false }`: the runner only looks documents up by it and the
   * mapper writes the array itself.
   */
  tenantScope?: { path: string; set: boolean }
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

export type ImportRemoval = {
  /** The update applied (or that would be). */
  action: Record<string, unknown>
  /** False when only reported: no `--apply-deletions`, a dry run, or the update failed. */
  applied: boolean
  collection: string
  id: number | string
  importer: string
  legacyId: number
}

export type ImporterResult = ImportCounts & {
  /** Why removals of this importer were not looked at (incomplete source read). */
  removalsRefused?: string
  /** Documents whose `refreshWhileSet` fields changed (counted in a dry run too). */
  refreshed?: number
  /** Extra counts the importer reports about its source data. */
  report?: Record<string, number>
  /** Why rows were skipped, by reason. */
  skipReasons?: Record<string, number>
  /** Skipped rows that gave no `legacyId` (blocks pruning). */
  skippedUnidentified?: number
  /** Set when the importer did not complete (read error or failed dependency). */
  aborted?: string
}

export type ImportSummary = {
  /** Sync: documents whose legacy row is gone, and what was (or would be) done to them. */
  removals: ImportRemoval[]
  dryRun: boolean
  errors: ImportFailure[]
  /** Importers in the order they ran (or were attempted). */
  importers: Record<string, ImporterResult>
  order: string[]
}
