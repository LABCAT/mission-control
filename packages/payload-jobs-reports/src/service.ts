import type { Payload, PayloadRequest } from 'payload'

import {
  forTenant,
  loadTenantSettings,
  type PayloadJobsRegistry,
  type ReportDefinition,
} from '@mission-control/payload-jobs'

import { toCSV } from './csv'

/** A request the caller got wrong (maps to HTTP 400, or 404 for an unknown report). */
export class ReportRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message)
  }
}

export type ReportRequest = {
  /** Comma separated or listed field keys. Empty means the report's default fields. */
  fields?: string[]
  from?: string
  key: string
  payload: Payload
  req?: PayloadRequest
  tenantID: null | number | string
  to?: string
}

/** The reports a tenant is offered: add-on switches applied, so a disabled add-on's reports are gone. */
export const reportsForTenant = async (
  registry: PayloadJobsRegistry,
  payload: Payload,
  tenantID: null | number | string,
  req?: PayloadRequest,
): Promise<ReportDefinition[]> =>
  forTenant(registry, registry.reports, await loadTenantSettings(registry, payload, tenantID, req))

/**
 * Run one report for one tenant and return the CSV text. Business logic lives here, not in the
 * endpoint or the admin view, so the Astro site can call it later.
 */
export const runReportCSV = async (
  registry: PayloadJobsRegistry,
  request: ReportRequest,
): Promise<{ csv: string; filename: string }> => {
  const offered = await reportsForTenant(registry, request.payload, request.tenantID, request.req)
  const report = offered.find((entry) => entry.key === request.key)
  if (!report) throw new ReportRequestError('Report not found', 404)

  const known = new Set(report.fields.map((field) => field.key))
  const requested = request.fields?.filter((field) => field !== '') ?? []
  const unknown = requested.filter((field) => !known.has(field))
  if (unknown.length > 0) throw new ReportRequestError(`Unknown field: ${unknown.join(', ')}`, 400)

  const fields =
    requested.length > 0 ? requested : report.fields.filter((field) => field.default === true).map((field) => field.key)

  let result
  try {
    result = await report.run({
      fields,
      from: request.from,
      payload: request.payload,
      req: request.req,
      tenantID: request.tenantID,
      to: request.to,
    })
  } catch (error) {
    if (error instanceof RangeError) throw new ReportRequestError(error.message, 400)
    throw error
  }

  const stamp = [request.from, request.to].filter(Boolean).join('_to_') || 'all'

  return { csv: toCSV(result.columns, result.rows), filename: `${report.key}-${stamp}.csv` }
}
