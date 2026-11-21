import type { Endpoint, PayloadRequest } from 'payload'

import {
  gateEndpoint,
  getUserTenantIDsByRole,
  hasAnyTenantRole,
  isSuperAdmin,
  type MissionControlUser,
  type PayloadJobsRegistry,
} from '@mission-control/payload-jobs'

import { REPORTS_ADD_ON_KEY } from './reports'
import { reportsForTenant, ReportRequestError, runReportCSV } from './service'

const NO_STORE = { 'Cache-Control': 'no-store' }

/** Roles that may run reports: the tenant's site managers (and super admins everywhere). */
const MANAGER_ROLES = ['tenant-admin'] as const

type Access = { response: Response } | { tenantID: null | number | string }

const fail = (error: string, status: number) => Response.json({ error }, { headers: NO_STORE, status })

/** Who the request is for. Never trusts the `tenant` parameter beyond the user's own memberships. */
const authorise = (registry: PayloadJobsRegistry, req: PayloadRequest): Access => {
  const user = req.user as MissionControlUser | null | undefined
  if (!user) return { response: fail('You must be signed in.', 401) }

  const superAdmin = isSuperAdmin(user)

  if (registry.context.tenancy === 'single') {
    return superAdmin || hasAnyTenantRole(user, MANAGER_ROLES)
      ? { tenantID: null }
      : { response: fail('Site manager access is required.', 403) }
  }

  const requested = req.searchParams?.get('tenant')
  if (superAdmin) {
    return requested ? { tenantID: requested } : { response: fail('Choose a tenant (?tenant=).', 400) }
  }

  const allowed = getUserTenantIDsByRole(user, MANAGER_ROLES).map(String)
  if (allowed.length === 0) return { response: fail('Site manager access is required.', 403) }
  if (requested === null || requested === undefined || requested === '') {
    return allowed.length === 1 ? { tenantID: allowed[0]! } : { response: fail('Choose a tenant (?tenant=).', 400) }
  }

  return allowed.includes(requested) ? { tenantID: requested } : { response: fail('Site manager access is required.', 403) }
}

/** Run `handler` for an authorised request, answering 404 when the tenant has the add-on off. */
const guarded =
  (registry: PayloadJobsRegistry, path: string, handler: (req: PayloadRequest, tenantID: null | number | string) => Promise<Response>): Endpoint =>
  ({
    handler: async (req) => {
      const access = authorise(registry, req)
      if ('response' in access) return access.response

      const gated = gateEndpoint(
        { key: REPORTS_ADD_ON_KEY, registry },
        { handler: (inner) => handler(inner, access.tenantID), method: 'get', path },
        () => access.tenantID,
      )

      return gated.handler(req)
    },
    method: 'get',
    path,
  })

/**
 * `GET /api/reports` lists the reports the tenant is offered; `GET /api/reports/:key/csv` downloads
 * one (`from`, `to` are calendar days, inclusive; `fields` is a comma separated list). Both
 * answer 404 when the tenant has the reports add-on off.
 */
export const reportEndpoints = (registry: PayloadJobsRegistry): Endpoint[] => [
  guarded(registry, '/reports', async (req, tenantID) => {
    const reports = await reportsForTenant(registry, req.payload, tenantID, req)

    return Response.json(
      {
        reports: reports.map(({ fields, key, label }) => ({ fields, key, label })),
      },
      { headers: NO_STORE },
    )
  }),
  guarded(registry, '/reports/:key/csv', async (req, tenantID) => {
    const query = req.searchParams
    try {
      const { csv, filename } = await runReportCSV(registry, {
        fields: query?.get('fields')?.split(',').map((field) => field.trim()),
        from: query?.get('from') || undefined,
        key: String((req.routeParams as { key?: string } | undefined)?.key ?? ''),
        payload: req.payload,
        req,
        tenantID,
        to: query?.get('to') || undefined,
      })

      return new Response(csv, {
        headers: {
          ...NO_STORE,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Type': 'text/csv; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (error) {
      if (error instanceof ReportRequestError) return fail(error.message, error.status)
      throw error
    }
  }),
]
