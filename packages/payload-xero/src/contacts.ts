/**
 * Find or create the Xero contact an order is invoiced to (PJ-56).
 *
 * Lookups run in a fixed order so a re-run invoices the same contact instead of creating a
 * duplicate: the payer's stored Xero code (`xeroContactCode`), then the legacy WordPress user
 * id as `AXI-{id}` (what the old plugin wrote into `ContactNumber`), then the email address.
 * Only when all three miss is a contact created.
 *
 * `fetch` only, with Xero's `xero-tenant-id` header, so this runs on Cloudflare Workers.
 */

export const XERO_API_BASE_URL = 'https://api.xero.com/api.xro/2.0'
/** Prefix of the contact code the WordPress plugin stored, so re-runs match its contacts. */
export const AXI_CONTACT_CODE_PREFIX = 'AXI-'

export const XERO_API_TIMEOUT_MS = 15_000

export type XeroContactErrorCode =
  | 'contact_create_failed'
  | 'contact_lookup_failed'
  | 'invalid_contact'
  | 'not_connected'

const STATUS: Record<XeroContactErrorCode, number> = {
  contact_create_failed: 502,
  contact_lookup_failed: 502,
  invalid_contact: 400,
  not_connected: 409,
}

/** A contact failure with a stable `code` for callers and the order log. Never holds a token. */
export class XeroContactError extends Error {
  readonly code: XeroContactErrorCode
  readonly details?: Record<string, unknown>
  readonly status: number

  constructor(code: XeroContactErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'XeroContactError'
    this.code = code
    this.details = details
    this.status = STATUS[code]
  }
}

export type XeroContact = {
  ContactID: string
  ContactNumber?: null | string
  ContactStatus?: null | string
  EmailAddress?: null | string
  Name?: null | string
}

export type XeroContactInput = {
  /** The payer's stored `xeroContactCode`. Tried first, and written when creating. */
  code?: null | string
  /** Contact email: the last lookup, and sent when creating. */
  email?: null | string
  /** WordPress user id of a migrated employer, looked up as `AXI-{id}`. */
  legacyUserId?: null | number
  /** Contact name. Xero requires one, so this is needed only when a contact is created. */
  name?: null | string
}

/** How the contact was found. `created` means none of the lookups matched. */
export type XeroContactMatch = 'code' | 'created' | 'email' | 'legacyId'

export type XeroContactResult = {
  contact: XeroContact
  matchedBy: XeroContactMatch
}

/** What every Xero Accounting API call needs: a token, the organisation, and an HTTP client. */
export type XeroApiArgs = {
  accessToken: string
  /** API root. Defaults to `https://api.xero.com/api.xro/2.0`; tests point it elsewhere. */
  apiBaseUrl?: string
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
  /** Xero organisation (tenant) ID, from the settings row. */
  tenantId: string
  /** Deadline for one API call. Defaults to 15s. */
  timeoutMs?: number
}

export type FindOrCreateContactArgs = XeroApiArgs & {
  contact: XeroContactInput
}

/** The code the WordPress plugin used for a legacy user's contact. */
export const legacyContactCode = (legacyUserId: number): string => {
  if (!Number.isInteger(legacyUserId) || legacyUserId <= 0) {
    throw new XeroContactError('invalid_contact', 'A legacy contact code needs a positive user id.')
  }

  return `${AXI_CONTACT_CODE_PREFIX}${legacyUserId}`
}

const text = (value: null | string | undefined): string | undefined => {
  const trimmed = typeof value === 'string' ? value.trim() : ''

  return trimmed ? trimmed : undefined
}

/**
 * A value that can go inside a Xero `where` clause. Xero's filter grammar has no documented
 * way to escape a double quote or a backslash, so a code that carries one is refused rather
 * than sent as a filter that matches something else.
 */
const filterValue = (value: string): string => {
  if (/["\\]/.test(value)) {
    throw new XeroContactError(
      'invalid_contact',
      'The Xero contact code or email cannot be used in a Xero lookup. Remove the quote or backslash.',
    )
  }

  return value
}

const isContact = (value: unknown): value is XeroContact =>
  Boolean(value) &&
  typeof value === 'object' &&
  typeof (value as { ContactID?: unknown }).ContactID === 'string' &&
  Boolean((value as { ContactID: string }).ContactID)

/** Xero's own message, which says what it disliked about a request. */
const xeroMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined

  const record = body as Record<string, unknown>
  if (typeof record.Message === 'string' && record.Message) return record.Message

  if (Array.isArray(record.Elements)) {
    const messages: string[] = []
    for (const element of record.Elements) {
      const errors = (element as { ValidationErrors?: unknown } | null)?.ValidationErrors
      if (!Array.isArray(errors)) continue

      for (const error of errors) {
        const message = (error as { Message?: unknown } | null)?.Message
        if (typeof message === 'string' && message) messages.push(message)
      }
    }

    if (messages.length > 0) return messages.join('; ')
  }

  return undefined
}

/** An archived contact cannot take a new invoice, so it does not count as a match. */
const usable = (contact: XeroContact): boolean => contact.ContactStatus !== 'ARCHIVED'

type XeroRequest = XeroApiArgs & {
  body?: unknown
  /** Error code for anything other than Xero answering with a usable body. */
  failure: XeroContactErrorCode
  method: 'GET' | 'POST'
  path: string
}

/**
 * One authenticated call. A transport failure, a non-JSON body and an error status all become
 * one `XeroContactError`, so callers (and PJ-57's retry job) need only one catch.
 */
const request = async ({
  accessToken,
  apiBaseUrl = XERO_API_BASE_URL,
  body,
  failure,
  fetch = globalThis.fetch,
  method,
  path,
  tenantId,
  timeoutMs = XERO_API_TIMEOUT_MS,
}: XeroRequest): Promise<unknown> => {
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'xero-tenant-id': tenantId,
      },
      method,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'

    throw new XeroContactError(
      failure,
      timedOut ? 'Xero did not answer in time.' : 'Could not reach Xero.',
      { cause: error instanceof Error ? error.name : 'network_error' },
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const message = xeroMessage(payload)

    throw new XeroContactError(
      failure,
      message
        ? `Xero refused the contact request: ${message}`
        : `Xero refused the contact request (HTTP ${response.status}).`,
      { ...(message ? { message: message.slice(0, 200) } : {}), status: response.status },
    )
  }

  return payload
}

const contactsFrom = (body: unknown, failure: XeroContactErrorCode): XeroContact[] => {
  const contacts = (body as { Contacts?: unknown } | null | undefined)?.Contacts

  if (!Array.isArray(contacts)) {
    throw new XeroContactError(failure, 'Xero returned an unreadable contacts response.')
  }

  return contacts.filter(isContact)
}

const findContact = async (api: XeroApiArgs, where: string): Promise<XeroContact | null> => {
  const body = await request({
    ...api,
    failure: 'contact_lookup_failed',
    method: 'GET',
    path: `/Contacts?${new URLSearchParams({ where }).toString()}`,
  })

  const contacts = contactsFrom(body, 'contact_lookup_failed')

  return contacts.find(usable) ?? null
}

const createContact = async (
  api: XeroApiArgs,
  fields: { ContactNumber?: string; EmailAddress?: string; Name: string },
): Promise<XeroContact> => {
  const body = await request({
    ...api,
    body: { Contacts: [fields] },
    failure: 'contact_create_failed',
    method: 'POST',
    path: '/Contacts',
  })

  const [created] = contactsFrom(body, 'contact_create_failed')

  if (!created) {
    throw new XeroContactError(
      'contact_create_failed',
      'Xero accepted the contact request but returned no contact.',
    )
  }

  return created
}

type Lookup = { code: string; matchedBy: 'code' | 'legacyId' } | { email: string; matchedBy: 'email' }

/**
 * The contact for this payer, creating one when no lookup matches. Lookups run in order:
 * stored code, `AXI-{legacyUserId}`, email.
 *
 * Throws `not_connected` when the settings row has no access token or organisation, and
 * `invalid_contact` when every lookup misses and there is no name to create a contact with.
 */
export const findOrCreateXeroContact = async (
  args: FindOrCreateContactArgs,
): Promise<XeroContactResult> => {
  const accessToken = text(args.accessToken)
  const tenantId = text(args.tenantId)

  if (!accessToken || !tenantId) {
    throw new XeroContactError(
      'not_connected',
      'Connect Xero for this tenant before invoicing an order.',
    )
  }

  const code = text(args.contact.code)
  const email = text(args.contact.email)
  const legacyCode =
    args.contact.legacyUserId === undefined || args.contact.legacyUserId === null
      ? undefined
      : legacyContactCode(args.contact.legacyUserId)

  // A stored code that already is the legacy code must not be searched twice.
  const lookups: Lookup[] = []
  const seen = new Set<string>()
  const addLookup = (lookup: Lookup): void => {
    const key = 'code' in lookup ? `code:${lookup.code}` : `email:${lookup.email}`
    if (seen.has(key)) return

    seen.add(key)
    lookups.push(lookup)
  }

  if (code) addLookup({ code, matchedBy: 'code' })
  if (legacyCode) addLookup({ code: legacyCode, matchedBy: 'legacyId' })
  if (email) addLookup({ email, matchedBy: 'email' })

  for (const lookup of lookups) {
    const where =
      'code' in lookup
        ? `ContactNumber=="${filterValue(lookup.code)}"`
        : `EmailAddress=="${filterValue(lookup.email)}"`
    const found = await findContact({ ...args, accessToken, tenantId }, where)

    if (found) return { contact: found, matchedBy: lookup.matchedBy }
  }

  const name = text(args.contact.name)
  if (!name) {
    throw new XeroContactError(
      'invalid_contact',
      'No Xero contact matched, and creating one needs a contact name.',
    )
  }

  const contactNumber = code ?? legacyCode
  const contact = await createContact({ ...args, accessToken, tenantId }, {
    ...(contactNumber ? { ContactNumber: contactNumber } : {}),
    ...(email ? { EmailAddress: email } : {}),
    Name: name,
  })

  return { contact, matchedBy: 'created' }
}
