import { Forbidden, type CollectionConfig, type Payload, type PayloadRequest } from 'payload'

import { superAdminAccess } from './access'

/**
 * Audit log (S-122). An append-only record of privileged actions: who did it, to whom, when.
 * Today it holds "view as user" starts, exits and the actions taken during one (PJ-119).
 *
 * - Readable by super admins only, and never writable through the REST/GraphQL API: only code
 *   with `overrideAccess` (this package) appends to it.
 * - Append-only even for that code: updates and deletes are refused. The test teardown passes
 *   `context.payloadJobsPurge`, the same escape hatch the credit ledger has.
 * - Ids are stored as plain text, not relationships, so deleting a user or tenant never changes
 *   or blocks an old entry.
 * - It holds no personal data beyond ids, and no secrets: tokens, codes and passwords are never
 *   written to `detail`.
 */
export const AUDIT_LOG_SLUG = 'audit-log'

/** Set on `req.context` by test teardown to remove audit rows. Never set in production code. */
export const AUDIT_LOG_PURGE_CONTEXT = 'payloadJobsPurge'

export type AuditEntry = {
  /** Machine name, e.g. `view-as.start`. */
  action: string
  /** User id of whoever did it (the super admin, for view-as). */
  actorID: number | string
  /** Free-form, non-secret context: collection, document id, reason a request was blocked. */
  detail?: Record<string, unknown>
  /** User session or impersonation id this action belongs to, to line start, actions and exit up. */
  sessionID?: string
  /** User id the action was done to or as. */
  targetID?: number | string
  tenantID?: number | string
}

const refuse = (req: { t?: unknown }): never => {
  throw new Forbidden(req.t as never)
}

export const auditLogCollection = (): CollectionConfig => ({
  slug: AUDIT_LOG_SLUG,
  admin: {
    defaultColumns: ['createdAt', 'action', 'actorID', 'targetID'],
    description: 'Privileged actions: who did what, to whom, and when. Append only.',
    group: 'System',
    useAsTitle: 'action',
  },
  access: {
    // Rows are appended by server code with overrideAccess. Nobody writes through the API.
    create: () => false,
    delete: () => false,
    read: superAdminAccess,
    update: () => false,
  },
  fields: [
    { name: 'action', type: 'text', index: true, required: true },
    { name: 'actorID', type: 'text', index: true, required: true },
    { name: 'targetID', type: 'text', index: true },
    { name: 'tenantID', type: 'text', index: true },
    { name: 'sessionID', type: 'text', index: true },
    { name: 'detail', type: 'json' },
  ],
  hooks: {
    beforeChange: [
      ({ data, operation, req }) => {
        // Only a create passes; an update means someone is trying to rewrite history.
        if (operation !== 'create') return refuse(req)

        return data
      },
    ],
    beforeDelete: [
      ({ req }) => {
        if (req.context?.[AUDIT_LOG_PURGE_CONTEXT]) return

        return refuse(req)
      },
    ],
  },
  versions: false,
})

const asText = (value: number | string | undefined): string | undefined =>
  value === undefined ? undefined : String(value)

/** True when the audit collection is registered on this Payload instance. */
export const hasAuditLog = (payload: Payload): boolean =>
  Boolean((payload.collections as Record<string, unknown>)[AUDIT_LOG_SLUG])

/**
 * Append an audit entry. Pass `req` to write inside the request's transaction, so a row never
 * outlives an action that rolled back and an action never commits without its row. Omit `req`
 * for entries that must survive a rollback, e.g. a blocked attempt whose request then throws.
 */
export const writeAuditLog = async ({
  entry,
  payload,
  req,
}: {
  entry: AuditEntry
  payload: Payload
  req?: PayloadRequest
}): Promise<void> => {
  await payload.create({
    collection: AUDIT_LOG_SLUG as never,
    data: {
      action: entry.action,
      actorID: String(entry.actorID),
      detail: entry.detail ?? {},
      sessionID: entry.sessionID,
      targetID: asText(entry.targetID),
      tenantID: asText(entry.tenantID),
    } as never,
    overrideAccess: true,
    ...(req ? { req } : {}),
  })
}
