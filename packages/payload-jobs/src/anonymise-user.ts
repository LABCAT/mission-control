import {
  APIError,
  Forbidden,
  type CollectionBeforeDeleteHook,
  type CollectionConfig,
  type Endpoint,
  type Payload,
  type PayloadRequest,
} from 'payload'

import { isSuperAdmin, getUserTenantIDsByRole, type MissionControlUser } from './access'
import { APPLICATION_FILES_SLUG, APPLICATIONS_SLUG } from './collections/applications'

/**
 * Personal data removal (PJ-89, S-311). There is no self-service account deletion in the MVP
 * (STATUS.md, 19 Nov): a person emails the site, and staff run the admin action. It anonymises
 * the user in place instead of deleting the row, so every money record that points at them
 * (orders, the credit ledger, invoices, authorship) keeps a stable, non-personal reference.
 *
 * A hard delete is refused instead: `createdBy`/`log.by` relationships cascade, so deleting a
 * buyer would take their order history with them (PJ-24 review).
 */

/** Set on `req.context` to allow a real delete, for test teardown and tenant cleanup only. */
export const USER_PURGE_CONTEXT = 'payloadJobsPurge'

/** Header the admin button sends; a cross-site form cannot set it without a CORS preflight. */
export const REMOVE_PERSONAL_DATA_CSRF_HEADER = 'x-mc-remove-personal-data'
export const REMOVE_PERSONAL_DATA_CSRF_VALUE = 'confirm'

/** Default slug of the job alerts collection (`payload-jobs-alerts`); used only if it exists. */
export const ALERT_SUBSCRIPTIONS_SLUG = 'alert-subscriptions'

/** Audit collection built by PJ-119. Written to only when it is registered. */
export const AUDIT_LOG_SLUG = 'audit-log'

export const REMOVED_USER_EMAIL_DOMAIN = 'removed.invalid'

/** Import-map path for the admin button (see `exports/client.ts`). */
export const REMOVE_PERSONAL_DATA_BUTTON_PATH =
  '@mission-control/payload-jobs/client#RemovePersonalDataButton'

/** Profile fields scrubbed when the collection has them. */
export const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'avatar', 'jobTitle'] as const

/** The address a removed user keeps. Stable per id, so it is unique and reveals nothing. */
export const removedUserEmail = (id: number | string): string =>
  `removed-user-${id}@${REMOVED_USER_EMAIL_DOMAIN}`

export type AnonymiseUserArgs = {
  /** Who ran the removal. Required: the audit entry names them. */
  actorID: number | string
  /** Slug of the job alerts collection; skipped when that collection is not registered. */
  alertSubscriptionsSlug?: string
  /** Slug of the applications collection. */
  applicationsSlug?: string
  /** Slug of the private upload collection holding CVs. */
  filesSlug?: string
  payload: Payload
  /** Free-form reason from the admin, e.g. a ticket number. Never personal data. */
  reason?: string
  /** Write inside the caller's transaction when given. */
  req?: PayloadRequest
  /** The user to anonymise. */
  userID: number | string
  /** Slug of the auth collection. */
  usersSlug?: string
}

export type AnonymiseUserResult = {
  applicationsRemoved: number
  email: string
  filesRemoved: number
  subscriptionsRemoved: number
  userID: number | string
}

type Doc = Record<string, unknown> & { id: number | string }

const idOf = (value: unknown): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return idOf((value as { id?: unknown }).id)
  return typeof value === 'number' || typeof value === 'string' ? value : null
}

const hasCollection = (payload: Payload, slug: string): boolean =>
  Boolean((payload.collections as Record<string, unknown>)[slug])

/**
 * Append the audit entry. PJ-119 owns the `audit-log` collection; when it is not in this
 * config (this branch, a host that left it out) the removal still leaves a structured log line
 * rather than silently dropping the trail.
 */
const writeRemovalAudit = async ({
  args,
  entry,
}: {
  args: AnonymiseUserArgs
  entry: Record<string, unknown>
}): Promise<void> => {
  const { payload } = args

  if (hasCollection(payload, AUDIT_LOG_SLUG)) {
    await payload.create({
      collection: AUDIT_LOG_SLUG as never,
      data: {
        action: 'user.personal-data-removed',
        actorID: String(args.actorID),
        detail: entry,
        targetID: String(args.userID),
        ...(entry.tenantID === undefined ? {} : { tenantID: String(entry.tenantID) }),
      } as never,
      overrideAccess: true,
      ...(args.req ? { req: args.req } : {}),
    })

    return
  }

  payload.logger.info({
    msg: 'user.personal-data-removed',
    ...entry,
    actorID: String(args.actorID),
    targetID: String(args.userID),
  })
}

const deleteWhere = async ({
  args,
  collection,
  where,
}: {
  args: AnonymiseUserArgs
  collection: string
  where: Record<string, unknown>
}): Promise<number> => {
  if (!hasCollection(args.payload, collection)) return 0

  const { docs } = (await args.payload.find({
    collection: collection as never,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    select: { id: true } as never,
    ...(args.req ? { req: args.req } : {}),
    where: where as never,
  })) as unknown as { docs: Doc[] }

  if (docs.length === 0) return 0

  await args.payload.delete({
    collection: collection as never,
    context: { [USER_PURGE_CONTEXT]: true },
    overrideAccess: true,
    ...(args.req ? { req: args.req } : {}),
    where: { id: { in: docs.map((doc) => doc.id) } } as never,
  })

  return docs.length
}

/**
 * Remove one user's personal data. Idempotent: running it twice removes nothing the second
 * time and leaves the same anonymised row.
 *
 * Deletes the user's applications (their own, and guest applications sent from their address),
 * the CVs and cover letters attached to those applications, and the job alert subscriptions for
 * their address. Then it clears the profile: name, phone, address, password, sessions, site
 * memberships and the WordPress link. Orders, invoices and the credit ledger are untouched and
 * keep pointing at the same user id.
 */
export const anonymiseUser = async (args: AnonymiseUserArgs): Promise<AnonymiseUserResult> => {
  const {
    alertSubscriptionsSlug = ALERT_SUBSCRIPTIONS_SLUG,
    applicationsSlug = APPLICATIONS_SLUG,
    filesSlug = APPLICATION_FILES_SLUG,
    payload,
    userID,
    usersSlug = 'users',
  } = args

  const user = (await payload
    .findByID({
      collection: usersSlug as never,
      depth: 0,
      id: userID as never,
      overrideAccess: true,
      ...(args.req ? { req: args.req } : {}),
    })
    .catch(() => null)) as Doc | null

  if (!user) throw new APIError('The user does not exist.', 404)

  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  const tenantIDs = Array.isArray(user.tenants)
    ? user.tenants.map((membership) => idOf((membership as { tenant?: unknown }).tenant)).filter(Boolean)
    : []

  // Their own applications, and guest applications sent from their address. Both hold personal
  // data (name, email, phone, message, CV) even when the applicant field is empty.
  const applicationWhere = email
    ? { or: [{ applicant: { equals: userID } }, { email: { equals: email } }] }
    : { applicant: { equals: userID } }

  const applications = (await payload.find({
    collection: applicationsSlug as never,
    depth: 0,
    overrideAccess: true,
    pagination: false,
    ...(args.req ? { req: args.req } : {}),
    where: applicationWhere as never,
  })) as unknown as { docs: (Doc & { coverLetter?: unknown; cv?: unknown })[] }

  const fileIDs = [
    ...new Set(
      applications.docs.flatMap((application) =>
        [idOf(application.cv), idOf(application.coverLetter)].filter(
          (id): id is number | string => id !== null,
        ),
      ),
    ),
  ]

  // Applications first: the file guard refuses to delete a CV an application still points at.
  const applicationsRemoved = await deleteWhere({
    args,
    collection: applicationsSlug,
    where: applicationWhere,
  })

  const filesRemoved =
    fileIDs.length > 0
      ? await deleteWhere({ args, collection: filesSlug, where: { id: { in: fileIDs } } })
      : 0

  const subscriptionsRemoved = email
    ? await deleteWhere({
        args,
        collection: alertSubscriptionsSlug,
        where: { email: { equals: email } },
      })
    : 0

  const scrub: Record<string, unknown> = { email: removedUserEmail(user.id) }

  // Only scrub fields this installation actually has: the host owns the users collection.
  const userCollection = payload.config.collections.find((entry) => entry.slug === usersSlug)
  const fieldNames = new Set(
    (userCollection?.fields ?? []).flatMap((field) =>
      'name' in field && typeof field.name === 'string' ? [field.name] : [],
    ),
  )
  const optional: Record<string, unknown> = {
    legacyId: null,
    legacyPasswordHash: null,
    lockUntil: null,
    loginAttempts: 0,
    organisation: null,
    sessions: [],
    tenants: [],
  }
  for (const [name, value] of Object.entries(optional)) {
    if (fieldNames.has(name)) scrub[name] = value
  }
  for (const name of PROFILE_FIELDS) {
    if (fieldNames.has(name)) scrub[name] = null
  }

  // A random password nobody holds: the row stays addressable but cannot sign in.
  scrub.password = `${crypto.randomUUID()}${crypto.randomUUID()}`

  await payload.update({
    collection: usersSlug as never,
    data: scrub as never,
    id: userID as never,
    overrideAccess: true,
    ...(args.req ? { req: args.req } : {}),
  })

  await writeRemovalAudit({
    args,
    entry: {
      applicationsRemoved,
      // Never the address that was removed: the audit trail must not keep the data it removed.
      filesRemoved,
      reason: args.reason,
      subscriptionsRemoved,
      tenantID: tenantIDs[0] ?? undefined,
      tenantIDs,
    },
  })

  return {
    applicationsRemoved,
    email: removedUserEmail(user.id),
    filesRemoved,
    subscriptionsRemoved,
    userID: user.id,
  }
}

/**
 * Who may remove a user's personal data: a super admin, or a site manager for a member of their
 * own site. Never themselves, never a super admin, and never while viewing as someone (PJ-119).
 */
export const canRemovePersonalData = ({
  target,
  user,
}: {
  target: { id: number | string; role?: null | string; tenants?: { tenant?: unknown }[] | null }
  user: MissionControlUser | null | undefined
}): boolean => {
  if (!user) return false
  // A view-as session (PJ-119) marks the request; it must never remove anyone's data.
  if ((user as { _viewAs?: unknown })._viewAs) return false
  if (String(user.id) === String(target.id)) return false
  if (isSuperAdmin(user)) return true
  if (target.role === 'super-admin') return false

  const managed = getUserTenantIDsByRole(user, ['tenant-admin'])
  if (managed.length === 0) return false

  const memberships = (target.tenants ?? []).map((membership) => idOf(membership.tenant))

  return memberships.some((id) => id !== null && managed.includes(id))
}

/** Refuse a real delete: it would cascade the user's orders and ledger rows away with them. */
export const blockUserHardDelete: CollectionBeforeDeleteHook = ({ req }) => {
  if (req.context?.[USER_PURGE_CONTEXT]) return

  throw new APIError(
    'Users are never deleted, because orders and the credit ledger point at them. Remove their personal data instead.',
    400,
    { errors: [{ message: 'Remove personal data instead of deleting the user', path: 'id' }] },
    true,
  )
}

export type PersonalDataRemovalOptions = {
  /** Slug of the job alerts collection, when it is installed. */
  alertSubscriptionsSlug?: string
  /** Slug of the applications collection. */
  applicationsSlug?: string
  /** Slug of the private upload collection. */
  filesSlug?: string
  /** Slug of the auth collection. */
  usersSlug?: string
}

/** `POST /api/users/:id/remove-personal-data`. */
export const removePersonalDataEndpoint = (
  options: PersonalDataRemovalOptions = {},
): Endpoint => ({
  handler: async (req) => {
    const usersSlug = options.usersSlug ?? 'users'
    const id = req.routeParams?.id as number | string | undefined
    if (id === undefined) throw new APIError('A user id is required.', 400)

    if (req.headers.get(REMOVE_PERSONAL_DATA_CSRF_HEADER) !== REMOVE_PERSONAL_DATA_CSRF_VALUE) {
      throw new Forbidden(req.t)
    }

    const target = (await req.payload
      .findByID({ collection: usersSlug as never, depth: 0, id: id as never, overrideAccess: true, req })
      .catch(() => null)) as null | {
      id: number | string
      role?: null | string
      tenants?: { tenant?: unknown }[] | null
    }

    if (!target) throw new APIError('The user does not exist.', 404)

    const actor = req.user as MissionControlUser | null | undefined
    if (!canRemovePersonalData({ target, user: actor })) throw new Forbidden(req.t)

    const body = (await req.json?.().catch(() => null)) as null | { reason?: unknown }

    const result = await anonymiseUser({
      ...options,
      actorID: actor!.id as number | string,
      payload: req.payload,
      reason: typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined,
      req,
      userID: target.id,
      usersSlug,
    })

    return Response.json(result)
  },
  method: 'post',
  path: '/:id/remove-personal-data',
})

/**
 * Add personal data removal to the users collection: the endpoint, the "Remove personal data"
 * button on the user screen, and the guard that refuses a real delete. No fields are added, so
 * this changes no schema.
 */
export const withPersonalDataRemoval = (
  collection: CollectionConfig,
  options: PersonalDataRemovalOptions = {},
): CollectionConfig => ({
  ...collection,
  admin: {
    ...collection.admin,
    components: {
      ...collection.admin?.components,
      edit: {
        ...collection.admin?.components?.edit,
        beforeDocumentControls: [
          ...(collection.admin?.components?.edit?.beforeDocumentControls ?? []),
          { path: REMOVE_PERSONAL_DATA_BUTTON_PATH },
        ],
      },
    },
  },
  endpoints:
    collection.endpoints === false
      ? false
      : [...(collection.endpoints ?? []), removePersonalDataEndpoint(options)],
  hooks: {
    ...collection.hooks,
    beforeDelete: [...(collection.hooks?.beforeDelete ?? []), blockUserHardDelete],
  },
})
