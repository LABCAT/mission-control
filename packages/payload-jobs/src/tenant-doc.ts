import type { CollectionSlug, GlobalSlug, PayloadRequest } from 'payload'

/**
 * The tenant's settings document: the tenants row in multi-tenant mode, the settings global in
 * single-tenant mode. The slugs come from the plugin's registered options (PJ-80), never from
 * a literal, so a host that renamed either still works. Read with `overrideAccess`: callers are
 * server code that has already decided who may act.
 */
export const loadTenantDoc = async (
  req: PayloadRequest,
  tenantID: null | number | string,
): Promise<null | Record<string, unknown>> => {
  const custom = (req.payload.config?.custom as {
    payloadJobs?: {
      registry?: { context?: { settingsSlug?: string; tenantsSlug?: string } }
      slugs?: { tenants?: string }
      tenancy?: 'multi' | 'single'
    }
  })?.payloadJobs
  const context = custom?.registry?.context
  const multi = custom?.tenancy ? custom.tenancy === 'multi' : true

  try {
    if (multi) {
      if (tenantID === null) return null
      return (await req.payload.findByID({
        collection: (context?.tenantsSlug ?? custom?.slugs?.tenants ?? 'tenants') as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id: tenantID,
        overrideAccess: true,
        req,
      })) as null | Record<string, unknown>
    }
    return (await req.payload.findGlobal({
      depth: 0,
      overrideAccess: true,
      req,
      slug: (context?.settingsSlug ?? 'job-board-settings') as GlobalSlug,
    })) as unknown as Record<string, unknown>
  } catch {
    // A host without the collection: callers fall back to their generic defaults.
    return null
  }
}
