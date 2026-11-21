/**
 * Invoice sync (PJ-57): turn a document of the host app (an order, a booking...) into a Xero
 * sales invoice, as a draft first and authorised once the host says the sale is confirmed.
 *
 * The plugin never knows the host's content model. An adapter maps a document to a neutral
 * invoice (`toInvoice`) and records the result on it (`onSynced`). What the plugin keeps is one
 * row per source document in its own collection (`xero-invoices`): the Xero invoice id, its
 * status and link, the last error and a short lease.
 *
 * Safe to run any number of times, concurrently:
 *
 * - one row per source document (unique index), so two runs share one record;
 * - a lease taken with one conditional UPDATE, so only one run talks to Xero at a time;
 * - the invoice id is saved the moment Xero answers, fenced on the lease;
 * - writes carry an `Idempotency-Key`, and a run that finds no stored id first looks the
 *   invoice up by its reference, so an answer lost on the way back never becomes a second
 *   invoice.
 *
 * A failure is recorded on the row. Errors a later attempt can fix (Xero down, the lease busy)
 * are thrown as retryable, and the retry task (`xeroInvoiceSyncTask`) runs them again.
 */
import type {
  Access,
  CollectionConfig,
  CollectionSlug,
  Payload,
  PayloadRequest,
  TaskConfig,
} from 'payload'

import { findOrCreateXeroContact, XeroContactError, type XeroApiArgs } from './contacts'
import {
  addDays,
  authoriseInvoice,
  buildDraftInvoice,
  createDraftInvoice,
  currencyExponent,
  decimalToMinor,
  findInvoicesByReference,
  getInvoice,
  getOnlineInvoiceUrl,
  invoiceInputProblems,
  sha256Hex,
  xeroDay,
  XeroInvoiceError,
  type XeroInvoiceInput,
  type XeroInvoiceRecord,
} from './invoices'
import { XeroOAuthError, type XeroOAuthOptions } from './oauth'
import { findSettingsWithTokens, getXeroAccessToken, type XeroSettingsDoc } from './token-store'

export const DEFAULT_INVOICES_SLUG = 'xero-invoices'
export const XERO_INVOICE_SYNC_TASK_SLUG = 'xero-invoice-sync'
/** The queue the CMS Worker runs each cron tick, as for the payment sync. */
export const XERO_INVOICE_SYNC_QUEUE = 'hourly'
/**
 * How long one run may hold a document's lease. Longer than the slowest run: up to six Xero
 * calls (contact lookups, reference lookup, create, authorise, link) at 15 seconds each.
 */
export const XERO_INVOICE_LEASE_MS = 5 * 60_000
/** Retries of the retry task, spaced exponentially from five minutes. */
export const XERO_INVOICE_SYNC_RETRIES = 6
const RETRY_DELAY_MS = 5 * 60_000

const SETTLED = new Set(['AUTHORISED', 'PAID'])
const OPEN = new Set(['DRAFT', 'SUBMITTED'])
const GONE = new Set(['DELETED', 'VOIDED'])

type ID = number | string

/** What the adapter is told about the settings row. Never includes tokens. */
export type XeroInvoiceSettings = {
  accountCodes: { addOn: null | string; discount: null | string; plan: null | string }
  authorise: boolean
  dueDays: number
  id: ID
  tenant: ID | null
}

/** The neutral invoice plus whether the sale is confirmed, so the invoice may be authorised. */
export type XeroInvoiceDraft = XeroInvoiceInput & {
  /** The host considers the sale final (checkout completed). Drafts are authorised then. */
  confirmed: boolean
}

/** What was recorded in Xero for one source document. */
export type XeroInvoiceSynced = {
  currency: string
  invoiceId: string
  invoiceNumber: null | string
  onlineUrl: null | string
  reference: string
  status: string
}

export type XeroInvoiceAdapterContext = {
  payload: Payload
  req?: PayloadRequest
  settings: XeroInvoiceSettings
}

/**
 * How the plugin reaches the host's documents. The plugin never reads or writes the source
 * collection except through these, and `findByID` with `overrideAccess` to load a document.
 */
export type XeroInvoiceAdapter<TDoc extends Record<string, unknown> = Record<string, any>> = {
  /** Map a document to an invoice, or `null` when it should have none (yet). */
  toInvoice: (doc: TDoc, context: XeroInvoiceAdapterContext) => null | Promise<null | XeroInvoiceDraft> | XeroInvoiceDraft
  /** Record the invoice on the document (idempotent: called again on every successful run). */
  onSynced?: (args: { doc: TDoc; invoice: XeroInvoiceSynced; payload: Payload; req?: PayloadRequest }) => Promise<void> | void
  /** The collection whose documents are invoiced. */
  sourceCollection: string
  /** Tenant scope: the document's tenant. Defaults to the document's tenant field. */
  tenantOf?: (doc: TDoc) => ID | null
}

export type XeroInvoicingOptions = {
  adapter: XeroInvoiceAdapter
  /** Sync collection slug. Defaults to `xero-invoices`. */
  invoicesSlug?: string
  /** The jobs queue retries go on. Defaults to `hourly`. */
  queue?: string
  /** Retry task slug. Defaults to `xero-invoice-sync`. */
  taskSlug?: string
}

/** Everything a sync needs, resolved once from the plugin options. */
export type ResolvedXeroInvoicing = {
  adapter: XeroInvoiceAdapter
  /** Read access for the sync rows; writes are system code only. */
  invoicesSlug: string
  oauth: XeroOAuthOptions
  queue: string
  scope: 'global' | 'tenant'
  settingsSlug: string
  taskSlug: string
  tenantField: string
}

// ---------------------------------------------------------------------------------------------
// Collection

const noWrite: Access = () => false

/** The sync rows: read-only in the API and the admin; system code writes them. */
export const buildXeroInvoicesCollection = ({
  group,
  read,
  slug,
}: {
  group?: string
  read: Access
  slug: string
}): CollectionConfig => ({
  slug,
  access: { create: noWrite, delete: noWrite, read, update: noWrite },
  admin: {
    defaultColumns: ['reference', 'invoiceNumber', 'status', 'lastError', 'updatedAt'],
    description: 'One row per invoiced document: the Xero invoice, and the last sync error. Written by the sync.',
    ...(group ? { group } : {}),
    useAsTitle: 'reference',
  },
  fields: [
    {
      type: 'row',
      fields: [
        { name: 'source', type: 'text', required: true, admin: { readOnly: true, description: 'Source collection.' } },
        { name: 'sourceId', type: 'text', required: true, admin: { readOnly: true } },
        { name: 'reference', type: 'text', admin: { readOnly: true } },
      ],
    },
    {
      type: 'row',
      fields: [
        { name: 'invoiceId', type: 'text', index: true, admin: { readOnly: true, description: 'Xero InvoiceID.' } },
        { name: 'invoiceNumber', type: 'text', admin: { readOnly: true } },
        { name: 'status', type: 'text', admin: { readOnly: true, description: 'Xero invoice status.' } },
      ],
    },
    { name: 'onlineUrl', type: 'text', admin: { readOnly: true } },
    {
      type: 'row',
      fields: [
        { name: 'attempts', type: 'number', defaultValue: 0, admin: { readOnly: true, description: 'Failed attempts since the last success.' } },
        { name: 'lastError', type: 'text', admin: { readOnly: true } },
        { name: 'lastAttemptAt', type: 'date', admin: { readOnly: true, date: { pickerAppearance: 'dayAndTime' } } },
      ],
    },
    {
      name: 'lease',
      type: 'group',
      admin: { hidden: true },
      fields: [
        { name: 'token', type: 'text' },
        { name: 'until', type: 'number' },
      ],
    },
  ],
  // One row per source document; in tenant scope the tenancy layer adds `tenantField`.
  indexes: [{ fields: ['source', 'sourceId'], unique: true }],
  versions: false,
})

// ---------------------------------------------------------------------------------------------
// Rows

type SyncRow = {
  attempts?: null | number
  id: ID
  invoiceId?: null | string
  invoiceNumber?: null | string
  lease?: null | { token?: null | string; until?: null | number }
  onlineUrl?: null | string
  reference?: null | string
  status?: null | string
  [key: string]: unknown
}

const idOf = (value: unknown): ID | null =>
  value && typeof value === 'object'
    ? idOf((value as { id?: unknown }).id)
    : typeof value === 'number' || typeof value === 'string'
      ? value
      : null

const sameID = (a: unknown, b: unknown): boolean => {
  const left = idOf(a)
  const right = idOf(b)

  return left === null ? right === null : right !== null && String(left) === String(right)
}

/*
 * The sync rows are written outside the caller's transaction, on purpose. A unique violation
 * inside an order's transaction would abort it and fail the order's save; and an invoice id that
 * Xero has already issued must be kept even if the order's save later rolls back. The row points
 * at its document by id only, so it never needs to see the document's uncommitted state.
 */
const findRow = async (config: ResolvedXeroInvoicing, payload: Payload, sourceId: string): Promise<null | SyncRow> => {
  const { docs } = await payload.find({
    collection: config.invoicesSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    showHiddenFields: true,
    where: {
      and: [{ source: { equals: config.adapter.sourceCollection } }, { sourceId: { equals: sourceId } }],
    },
  })

  return (docs[0] as unknown as SyncRow | undefined) ?? null
}

/** The row for this document, created on first use. Two concurrent creates share one row. */
const ensureRow = async (
  config: ResolvedXeroInvoicing,
  payload: Payload,
  { reference, sourceId, tenantID }: { reference: string; sourceId: string; tenantID: ID | null },
): Promise<SyncRow> => {
  const existing = await findRow(config, payload, sourceId)
  if (existing) return existing

  try {
    return (await payload.create({
      collection: config.invoicesSlug as CollectionSlug,
      data: {
        attempts: 0,
        reference,
        source: config.adapter.sourceCollection,
        sourceId,
        ...(config.scope === 'tenant' ? { [config.tenantField]: tenantID } : {}),
      } as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as SyncRow
  } catch (error) {
    // A concurrent run created it first. Payload reports the unique index as a raw Postgres
    // error or as a field ValidationError, depending on the path, so look before deciding.
    const raced = await findRow(config, payload, sourceId).catch(() => null)
    if (!raced) throw error
    return raced
  }
}

/** One conditional UPDATE: of any number of concurrent runs, exactly one gets the lease. */
const claimLease = async (config: ResolvedXeroInvoicing, payload: Payload, rowID: ID): Promise<null | string> => {
  const token = crypto.randomUUID()
  const claimed = await payload.db.updateOne({
    collection: config.invoicesSlug as CollectionSlug,
    data: { lease: { token, until: Date.now() + XERO_INVOICE_LEASE_MS } },
    where: {
      and: [
        { id: { equals: rowID } },
        { or: [{ 'lease.until': { exists: false } }, { 'lease.until': { less_than: Date.now() } }] },
      ],
    },
  })

  return claimed ? token : null
}

/** Write to the row only while this run still holds the lease. Returns false when it lost it. */
const fencedUpdate = async (
  config: ResolvedXeroInvoicing,
  payload: Payload,
  rowID: ID,
  token: string,
  data: Record<string, unknown>,
): Promise<boolean> => {
  const saved = await payload.db.updateOne({
    collection: config.invoicesSlug as CollectionSlug,
    data,
    where: { and: [{ id: { equals: rowID } }, { 'lease.token': { equals: token } }] },
  })

  return Boolean(saved)
}

// ---------------------------------------------------------------------------------------------
// Settings

const text = (value: unknown): null | string => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The adapter's view of the settings row: account codes and invoicing rules, never tokens. */
export const invoiceSettingsOf = (row: XeroSettingsDoc, tenantField = 'tenant'): XeroInvoiceSettings => {
  const codes = (row.accountCodes ?? {}) as Record<string, unknown>
  const invoicing = (row.invoicing ?? {}) as Record<string, unknown>
  const dueDays = typeof row.dueDays === 'number' && Number.isInteger(row.dueDays) && row.dueDays >= 0 ? row.dueDays : 14

  return {
    accountCodes: { addOn: text(codes.addOn), discount: text(codes.discount), plan: text(codes.plan) },
    // Authorising is the default; a tenant that reviews drafts in Xero turns it off.
    authorise: invoicing.authorise !== false,
    dueDays,
    id: row.id,
    tenant: idOf(row[tenantField]),
  }
}

/** The settings row (with tokens) for a tenant, or the global row. `null` when there is none. */
export const findInvoiceSettings = async (
  config: Pick<ResolvedXeroInvoicing, 'scope' | 'settingsSlug' | 'tenantField'>,
  payload: Payload,
  tenantID: ID | null,
): Promise<null | XeroSettingsDoc> => {
  if (config.scope === 'tenant' && tenantID === null) return null

  const { docs } = await payload.find({
    collection: config.settingsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    ...(config.scope === 'tenant' ? { where: { [config.tenantField]: { equals: tenantID } } } : {}),
  })
  const row = docs[0] as unknown as undefined | { id: ID }
  if (!row) return null

  const settings = await findSettingsWithTokens({ collection: config.settingsSlug, id: row.id, payload })
  // Tenant isolation: a row that is not this tenant's is never used, whatever the query said.
  if (settings && config.scope === 'tenant' && !sameID(settings[config.tenantField], tenantID)) return null

  return settings
}

// ---------------------------------------------------------------------------------------------
// Sync

export type XeroInvoiceSyncAction = 'authorised' | 'created' | 'skipped' | 'unchanged' | 'updated'

export type XeroInvoiceSyncResult = {
  action: XeroInvoiceSyncAction
  invoice?: XeroInvoiceSynced
  /** Why nothing was done, for `skipped`. */
  reason?: 'no_invoice' | 'not_configured' | 'source_not_found'
}

const errorText = (error: unknown): string => {
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : 'unknown error'

  return `${typeof code === 'string' ? `${code}: ` : ''}${message}`.slice(0, 300)
}

/** Contact and OAuth failures in the invoice error vocabulary, keeping whether a retry helps. */
const asInvoiceError = (error: unknown): unknown => {
  if (error instanceof XeroInvoiceError) return error
  if (error instanceof XeroContactError) {
    if (error.code === 'not_connected') return new XeroInvoiceError('not_connected', error.message)
    if (error.code === 'invalid_contact') return new XeroInvoiceError('invalid_invoice', error.message)
    const status = typeof error.details?.status === 'number' ? error.details.status : null
    const transient = status === null || status === 401 || status === 429 || status >= 500

    return new XeroInvoiceError(transient ? 'xero_unavailable' : 'xero_rejected', error.message, error.details)
  }
  if (error instanceof XeroOAuthError) {
    // A refresh that failed or raced may work next time; a tenant that never connected will not.
    return error.code === 'not_connected' || error.code === 'not_configured'
      ? new XeroInvoiceError('not_connected', error.message)
      : new XeroInvoiceError('xero_unavailable', error.message, { oauth: error.code })
  }

  return error
}

const totalOf = (invoice: XeroInvoiceRecord, currency: string): null | number =>
  decimalToMinor(invoice.Total, currencyExponent(currency))

/**
 * Bring one source document's Xero invoice up to date: create the draft if there is none,
 * authorise it once the sale is confirmed (and the settings allow it), fetch its online link,
 * then hand the result to `adapter.onSynced`. Does nothing in Xero when there is nothing to do.
 */
export const syncXeroInvoice = async ({
  config,
  payload,
  req,
  sourceId: rawSourceId,
}: {
  config: ResolvedXeroInvoicing
  payload: Payload
  req?: PayloadRequest
  sourceId: ID
}): Promise<XeroInvoiceSyncResult> => {
  const sourceId = String(rawSourceId)
  const { adapter } = config

  const doc = (await payload.findByID({
    collection: adapter.sourceCollection as CollectionSlug,
    depth: 0,
    disableErrors: true,
    id: rawSourceId,
    overrideAccess: true,
    req,
  })) as null | Record<string, unknown>
  if (!doc) return { action: 'skipped', reason: 'source_not_found' }

  const tenantID = config.scope === 'tenant' ? idOf(adapter.tenantOf ? adapter.tenantOf(doc) : doc[config.tenantField]) : null
  const settingsRow = await findInvoiceSettings(config, payload, tenantID)
  // No settings row: this tenant does not invoice through Xero.
  if (!settingsRow) return { action: 'skipped', reason: 'not_configured' }

  const settings = invoiceSettingsOf(settingsRow, config.tenantField)
  const draft = await adapter.toInvoice(doc, { payload, req, settings })
  if (!draft) return { action: 'skipped', reason: 'no_invoice' }

  const problems = invoiceInputProblems(draft)
  if (problems.length > 0) {
    throw new XeroInvoiceError('invalid_invoice', `The invoice cannot be sent: ${problems.join('; ')}.`)
  }

  const row = await ensureRow(config, payload, { reference: draft.reference, sourceId, tenantID })
  if (config.scope === 'tenant' && !sameID(row[config.tenantField], tenantID)) {
    // A row of another tenant for the same document id can only be a bug; never touch it.
    throw new XeroInvoiceError('invalid_invoice', 'The invoice record belongs to another tenant.')
  }

  const wantAuthorised = draft.confirmed && settings.authorise
  const needsWork = (current: SyncRow): boolean =>
    !current.invoiceId ||
    (wantAuthorised && !SETTLED.has(current.status ?? '')) ||
    (SETTLED.has(current.status ?? '') && !current.onlineUrl)

  const synced = (current: SyncRow): XeroInvoiceSynced => ({
    currency: draft.currency,
    invoiceId: current.invoiceId as string,
    invoiceNumber: current.invoiceNumber ?? null,
    onlineUrl: current.onlineUrl ?? null,
    reference: current.reference ?? draft.reference,
    status: current.status ?? 'DRAFT',
  })

  // Nothing to do in Xero: just make sure the host has recorded it. No token, no lease.
  if (!needsWork(row)) {
    if (row.invoiceId) await adapter.onSynced?.({ doc, invoice: synced(row), payload, req })
    return { action: 'unchanged', ...(row.invoiceId ? { invoice: synced(row) } : {}) }
  }

  const token = await claimLease(config, payload, row.id)
  if (!token) throw new XeroInvoiceError('sync_in_progress', 'Another run is syncing this invoice. It will be retried.')

  let action: XeroInvoiceSyncAction = 'updated'
  let current: SyncRow = row

  try {
    // Re-read under the lease: the previous holder may have just finished.
    current = (await findRow(config, payload, sourceId)) ?? row
    if (!needsWork(current)) {
      action = 'unchanged'
    } else {
      if (!settingsRow.xeroTenantId) throw new XeroInvoiceError('not_connected', 'Connect Xero for this tenant before invoicing.')

      const { accessToken } = await getXeroAccessToken({
        collection: config.settingsSlug,
        oauth: config.oauth,
        payload,
        settings: settingsRow,
      })
      const api: XeroApiArgs = {
        accessToken,
        tenantId: settingsRow.xeroTenantId,
        ...(config.oauth.fetch ? { fetch: config.oauth.fetch } : {}),
      }
      const save = async (data: Record<string, unknown>): Promise<void> => {
        if (!(await fencedUpdate(config, payload, current.id, token, data))) {
          throw new XeroInvoiceError('sync_in_progress', 'The sync lease lapsed. It will be retried.')
        }
        current = { ...current, ...data }
      }

      let invoice: null | XeroInvoiceRecord = null

      if (!current.invoiceId) {
        const { contact } = await findOrCreateXeroContact({ ...api, contact: draft.contact })
        const exponent = currencyExponent(draft.currency)

        // A lost answer from an earlier run: the invoice is in Xero but its id never got here.
        // Adopt it only when it is unmistakably this document's.
        const existing = await findInvoicesByReference(api, draft.reference)
        const ours = existing.filter(
          (candidate) =>
            candidate.Contact?.ContactID === contact.ContactID &&
            candidate.CurrencyCode === draft.currency &&
            decimalToMinor(candidate.Total, exponent) === draft.expectedTotal,
        )
        if (ours.length > 1) {
          throw new XeroInvoiceError(
            'reference_conflict',
            `Xero has ${ours.length} invoices with reference "${draft.reference}" for this contact. Keep one, void the rest.`,
          )
        }

        if (ours[0]) {
          invoice = ours[0]
        } else {
          const body = buildDraftInvoice(draft, contact.ContactID, {
            brandingThemeId: text(settingsRow.brandingThemeId),
            tracking: settingsRow.trackingCategory as null | { name?: string; option?: string },
          })
          // Same request, same key: a resend returns the first invoice. A changed request (new
          // settings, say) gets a new key, and the reference lookup above covers that case.
          const key = `${config.invoicesSlug}:${current.id}:create:${(await sha256Hex(JSON.stringify(body))).slice(0, 32)}`
          invoice = await createDraftInvoice(api, body, key)
          action = 'created'
        }

        await save({
          invoiceId: invoice.InvoiceID,
          invoiceNumber: invoice.InvoiceNumber ?? null,
          reference: draft.reference,
          status: invoice.Status ?? 'DRAFT',
        })

        // Caught now rather than at authorisation, so the row shows it while it is a draft.
        const total = totalOf(invoice, draft.currency)
        if (OPEN.has(invoice.Status ?? '') && total !== draft.expectedTotal) {
          throw new XeroInvoiceError(
            'total_mismatch',
            `The Xero invoice totals ${total ?? 'an unreadable amount'}, not ${draft.expectedTotal}; it stays a draft.`,
            { expected: draft.expectedTotal, xero: total },
          )
        }
      }

      if (wantAuthorised && !SETTLED.has(current.status ?? '')) {
        // Staff may have changed the invoice in Xero since: read it before acting on it.
        invoice = (invoice && invoice.InvoiceID === current.invoiceId ? invoice : null) ?? (await getInvoice(api, current.invoiceId as string))
        if (!invoice || GONE.has(invoice.Status ?? '')) {
          if (invoice) await save({ status: invoice.Status })
          throw new XeroInvoiceError('invoice_voided', 'The Xero invoice was voided or deleted. A person decides what happens next.')
        }

        if (OPEN.has(invoice.Status ?? '')) {
          const total = totalOf(invoice, draft.currency)
          if (total !== draft.expectedTotal) {
            throw new XeroInvoiceError(
              'total_mismatch',
              `The Xero invoice totals ${total ?? 'an unreadable amount'}, not ${draft.expectedTotal}; it stays a draft.`,
              { expected: draft.expectedTotal, xero: total },
            )
          }

          const day = xeroDay(invoice) ?? new Date().toISOString().slice(0, 10)
          invoice = await authoriseInvoice(
            api,
            { dueDate: addDays(day, settings.dueDays), invoiceId: invoice.InvoiceID },
            `${config.invoicesSlug}:${current.id}:authorise:${invoice.InvoiceID}`,
          )
          if (action !== 'created') action = 'authorised'
        }

        await save({ invoiceNumber: invoice.InvoiceNumber ?? current.invoiceNumber ?? null, status: invoice.Status ?? current.status })
      }

      if (SETTLED.has(current.status ?? '') && !current.onlineUrl) {
        const url = await getOnlineInvoiceUrl(api, current.invoiceId as string)
        if (url) await save({ onlineUrl: url })
      }
    }

    // Success: clear the error and give the lease back in one fenced write.
    await fencedUpdate(
      config,
      payload,
      current.id,
      token,
      { attempts: 0, lastAttemptAt: new Date().toISOString(), lastError: null, lease: { token: null, until: null } },
    )
  } catch (thrown) {
    const error = asInvoiceError(thrown)
    await fencedUpdate(
      config,
      payload,
      current.id,
      token,
      {
        attempts: (current.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        lastError: errorText(error),
        lease: { token: null, until: null },
      },
    ).catch(() => undefined)
    throw error
  }

  if (current.invoiceId) await adapter.onSynced?.({ doc, invoice: synced(current), payload, req })

  return { action, ...(current.invoiceId ? { invoice: synced(current) } : {}) }
}

// ---------------------------------------------------------------------------------------------
// Retry task

export type XeroInvoiceSyncInput = { sourceId: string }

/**
 * The retry job: syncs one source document. A retryable failure is thrown so Payload retries it
 * (exponential backoff from five minutes, `XERO_INVOICE_SYNC_RETRIES` times); a failure only a
 * person can fix is recorded on the row and ends the job, since retrying would change nothing.
 */
export const xeroInvoiceSyncTask = (config: ResolvedXeroInvoicing): TaskConfig<never> =>
  ({
    slug: config.taskSlug,
    inputSchema: [{ name: 'sourceId', type: 'text', required: true }],
    outputSchema: [
      { name: 'action', type: 'text' },
      { name: 'error', type: 'text' },
    ],
    retries: { attempts: XERO_INVOICE_SYNC_RETRIES, backoff: { delay: RETRY_DELAY_MS, type: 'exponential' } },
    handler: async ({ input, req }: { input: XeroInvoiceSyncInput; req: PayloadRequest }) => {
      try {
        const result = await syncXeroInvoice({ config, payload: req.payload, req, sourceId: input.sourceId })
        return { output: { action: result.action } }
      } catch (error) {
        if (error instanceof XeroInvoiceError && !error.retryable) {
          req.payload.logger.error(
            { code: error.code, source: config.adapter.sourceCollection, sourceId: input.sourceId },
            'xero invoice sync needs attention',
          )
          return { output: { action: 'failed', error: error.code } }
        }
        throw error
      }
    },
  }) as unknown as TaskConfig<never>

/** Queue a retry for one document. Pass the request so it commits with the caller's write. */
export const queueXeroInvoiceSync = async ({
  config,
  payload,
  req,
  sourceId,
}: {
  config: ResolvedXeroInvoicing
  payload: Payload
  req?: PayloadRequest
  sourceId: ID
}): Promise<void> => {
  await payload.jobs.queue({
    input: { sourceId: String(sourceId) },
    overrideAccess: true,
    queue: config.queue,
    req,
    task: config.taskSlug,
  } as never)
}

/**
 * Sync now and queue a retry on a retryable failure: what an order hook calls. Never throws, so
 * a Xero outage never fails the host's write; the outcome is logged without tokens.
 */
export const syncOrQueueXeroInvoice = async (args: {
  config: ResolvedXeroInvoicing
  payload: Payload
  req?: PayloadRequest
  sourceId: ID
}): Promise<XeroInvoiceSyncResult | { action: 'failed'; code: string; queued: boolean }> => {
  try {
    return await syncXeroInvoice(args)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    const retryable = !(error instanceof XeroInvoiceError) || error.retryable
    let queued = false

    if (retryable) {
      try {
        await queueXeroInvoiceSync(args)
        queued = true
      } catch (queueError) {
        args.payload.logger.error(
          { err: errorText(queueError), sourceId: String(args.sourceId) },
          'xero invoice retry could not be queued',
        )
      }
    }

    args.payload.logger.error(
      { code: typeof code === 'string' ? code : 'unknown', queued, source: args.config.adapter.sourceCollection, sourceId: String(args.sourceId) },
      'xero invoice sync failed',
    )

    return { action: 'failed', code: typeof code === 'string' ? code : 'unknown', queued }
  }
}

/** Resolve the invoicing options against the plugin's settings options. */
export const resolveXeroInvoicing = ({
  invoicing,
  oauth,
  scope = 'global',
  settingsSlug = 'xero-settings',
  tenantField = 'tenant',
}: {
  invoicing: XeroInvoicingOptions
  oauth?: false | XeroOAuthOptions
  scope?: 'global' | 'tenant'
  settingsSlug?: string
  tenantField?: string
}): ResolvedXeroInvoicing => ({
  adapter: invoicing.adapter,
  invoicesSlug: invoicing.invoicesSlug ?? DEFAULT_INVOICES_SLUG,
  oauth: oauth || {},
  queue: invoicing.queue ?? XERO_INVOICE_SYNC_QUEUE,
  scope,
  settingsSlug,
  taskSlug: invoicing.taskSlug ?? XERO_INVOICE_SYNC_TASK_SLUG,
  tenantField,
})
