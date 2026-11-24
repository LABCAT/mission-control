import {
  getFieldsToSign,
  jwtSign,
  type CollectionSlug,
  type Field,
  type Payload,
  type PayloadRequest,
} from 'payload'
import { addSessionToUser, removeExpiredSessions } from 'payload/shared'

/**
 * Site session lengths (PJ-109). "Keep me signed in" picks between two per-tenant lengths:
 *
 * - unticked: the session ends after `sessionDefaultDays` (vwok: 1);
 * - ticked: it lasts `sessionKeepSignedInDays` (vwok: 30) and rolls, so every use that is more
 *   than a day after the last renewal pushes the end out again.
 *
 * The length is set when the session is created, because Payload's own `tokenExpiration` is one
 * value for the whole collection. The session row on the user and the JWT both carry it.
 */

export const DEFAULT_SESSION_DAYS = 1
export const DEFAULT_KEEP_SIGNED_IN_DAYS = 30
export const MAX_SESSION_DAYS = 365

const DAY_SECONDS = 86_400

/** Claim on a rolling token: its full length in seconds. Absent on a session that does not roll. */
export const ROLLING_CLAIM = 'ksi'

/** The tenant fields the session length reads. */
export type TenantSessionSettings = {
  sessionDefaultDays?: null | number
  sessionKeepSignedInDays?: null | number
}

const days = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= MAX_SESSION_DAYS
    ? Math.floor(value)
    : fallback

/** Session length in seconds for a tenant. A missing or odd setting keeps the legacy default. */
export const sessionSeconds = (
  tenant: null | TenantSessionSettings | undefined,
  keepSignedIn: boolean,
): number =>
  (keepSignedIn
    ? days(tenant?.sessionKeepSignedInDays, DEFAULT_KEEP_SIGNED_IN_DAYS)
    : days(tenant?.sessionDefaultDays, DEFAULT_SESSION_DAYS)) * DAY_SECONDS

const validateDays = (value: null | number | undefined): string | true =>
  value === null ||
  value === undefined ||
  (Number.isInteger(value) && value >= 1 && value <= MAX_SESSION_DAYS) ||
  `Use a whole number of days from 1 to ${MAX_SESSION_DAYS}`

/** The two session-length fields for the tenants collection. */
export const tenantSessionFields = (
  condition?: (data: Record<string, unknown>) => boolean,
): Field[] => [
  {
    name: 'sessionDefaultDays',
    type: 'number',
    defaultValue: DEFAULT_SESSION_DAYS,
    validate: validateDays as never,
    admin: {
      ...(condition ? { condition } : {}),
      description: 'Days a site sign-in lasts when "Keep me signed in" is not ticked.',
    },
  },
  {
    name: 'sessionKeepSignedInDays',
    type: 'number',
    defaultValue: DEFAULT_KEEP_SIGNED_IN_DAYS,
    validate: validateDays as never,
    admin: {
      ...(condition ? { condition } : {}),
      description:
        'Days a sign-in lasts when "Keep me signed in" is ticked. It renews each time the visitor comes back.',
    },
  },
]

type RawSessionUser = {
  email: string
  id: number | string
  sessions?: { expiresAt: Date | string; id: string }[]
}

const readUser = async (payload: Payload, usersSlug: string, id: number | string) =>
  (await payload.db.findOne({
    collection: usersSlug as CollectionSlug,
    where: { id: { equals: id } },
  })) as unknown as null | RawSessionUser

export type IssuedSession = {
  exp: number
  expiresIn: number
  keepSignedIn: boolean
  token: string
}

const sign = async ({
  extra,
  payload,
  seconds,
  sid,
  user,
  usersSlug,
}: {
  extra: Record<string, unknown>
  payload: Payload
  seconds: number
  sid: string
  user: RawSessionUser
  usersSlug: string
}) => {
  const collectionConfig = payload.collections[usersSlug as CollectionSlug].config

  return jwtSign({
    fieldsToSign: {
      ...getFieldsToSign({ collectionConfig, email: user.email, sid, user: user as never }),
      ...extra,
    },
    secret: payload.secret,
    tokenExpiration: seconds,
  })
}

/**
 * Start a session of `seconds` for the user and sign the token for it. It is the same kind of
 * session a Payload login creates (it can be revoked, and a password reset ends it), only with
 * the tenant's length instead of the collection-wide one.
 */
export const issueSession = async ({
  keepSignedIn,
  payload,
  seconds,
  userID,
  usersSlug,
}: {
  keepSignedIn: boolean
  payload: Payload
  seconds: number
  userID: number | string
  usersSlug: string
}): Promise<IssuedSession> => {
  const user = await readUser(payload, usersSlug, userID)
  if (!user) throw new Error('issueSession: user not found')

  const { sid } = await addSessionToUser({
    collectionConfig: payload.collections[usersSlug as CollectionSlug].config,
    payload,
    req: { payload } as PayloadRequest,
    sessionExpiration: seconds,
    user: user as never,
  })

  if (!sid) throw new Error('issueSession: sessions must be enabled on the users collection')

  const { exp, token } = await sign({
    extra: keepSignedIn ? { [ROLLING_CLAIM]: seconds } : {},
    payload,
    seconds,
    sid,
    user,
    usersSlug,
  })

  return { exp, expiresIn: seconds, keepSignedIn, token }
}

const decodeClaims = (token: string): null | Record<string, unknown> => {
  try {
    const part = token.split('.')[1]
    if (!part) return null

    const binary = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes))

    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The session id in a token Payload has already verified. */
export const sessionIDOf = (token: string): null | string => {
  const sid = decodeClaims(token)?.sid

  return typeof sid === 'string' ? sid : null
}

/** A rolling token is renewed when a day or more has gone by since it was issued. */
const RENEW_AFTER_SECONDS = DAY_SECONDS

/**
 * Roll a "Keep me signed in" session. Call it only for a token Payload has just accepted: it
 * reads the claims without checking the signature again. Returns a new token when the session was
 * extended, and null when the token does not roll or was renewed recently.
 */
export const renewRollingSession = async ({
  maxSeconds = MAX_SESSION_DAYS * DAY_SECONDS,
  now = Date.now(),
  payload,
  token,
  userID,
  usersSlug,
}: {
  /** The tenant's current ticked length. An older, longer token is cut to it. */
  maxSeconds?: number
  now?: number
  payload: Payload
  token: string
  userID: number | string
  usersSlug: string
}): Promise<IssuedSession | null> => {
  const claims = decodeClaims(token)
  const length = claims?.[ROLLING_CLAIM]
  const sid = claims?.sid
  const iat = claims?.iat

  if (typeof length !== 'number' || length <= 0 || typeof sid !== 'string' || typeof iat !== 'number') {
    return null
  }

  const nowSeconds = Math.floor(now / 1000)
  if (nowSeconds - iat < RENEW_AFTER_SECONDS) return null

  // The tenant may have shortened the setting since this session began: the setting wins.
  const seconds = Math.min(length, maxSeconds, MAX_SESSION_DAYS * DAY_SECONDS)

  const user = await readUser(payload, usersSlug, userID)
  const session = user?.sessions?.find(({ id }) => id === sid)
  if (!user || !session) return null

  session.expiresAt = new Date(now + seconds * 1000)

  await payload.db.updateOne({
    id: user.id,
    collection: usersSlug as CollectionSlug,
    data: {
      ...user,
      sessions: removeExpiredSessions(user.sessions ?? []),
      // Renewing a session is not an edit of the user.
      updatedAt: null,
    },
    returning: false,
  })

  const { exp, token: renewed } = await sign({
    extra: { [ROLLING_CLAIM]: seconds },
    payload,
    seconds,
    sid,
    user,
    usersSlug,
  })

  return { exp, expiresIn: seconds, keepSignedIn: true, token: renewed }
}

/** Remove one session from the user, so its token stops working. */
export const dropSession = async ({
  payload,
  sid,
  userID,
  usersSlug,
}: {
  payload: Payload
  sid: string
  userID: number | string
  usersSlug: string
}): Promise<void> => {
  const user = await readUser(payload, usersSlug, userID)
  if (!user?.sessions?.some(({ id }) => id === sid)) return

  await payload.db.updateOne({
    id: user.id,
    collection: usersSlug as CollectionSlug,
    data: { ...user, sessions: user.sessions.filter(({ id }) => id !== sid), updatedAt: null },
    returning: false,
  })
}
