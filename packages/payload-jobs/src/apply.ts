import type { CollectionSlug, Endpoint, PayloadRequest } from 'payload'

import {
  AccountAuthError,
  accountResponse,
  enforceRateLimit,
  resolveAccountUser,
  type AccountTenant,
} from './account-auth'
import {
  APPLICATION_FILE_MAX_BYTES,
  APPLICATION_FILES_SLUG,
  APPLICATION_MESSAGE_MAX_LENGTH,
  APPLICATIONS_SLUG,
} from './collections/applications'
import { FORM_HONEYPOT_FIELD, TURNSTILE_TOKEN_FIELD, verifyTurnstileWithCloudflare, type TurnstileVerifier } from './forms'
import type { RateLimiter } from './rate-limit'
import { resolveSiteKey } from './site-keys'
import { DEFAULT_PAYLOAD_JOBS_SLUGS, type PayloadJobsCollectionSlugs } from './slugs'

/**
 * The apply endpoint (PJ-45): `POST /api/<jobs>/:id/apply`, multipart, called by the site's own
 * proxy with its site key. Everything the visitor could lie about is decided here:
 *
 * - the tenant comes from the site key and the job must belong to it;
 * - the job must be live and have online applying switched on;
 * - when the tenant requires an account, a signed-in member of the tenant must be present;
 * - Turnstile, a honeypot and per IP / per email limits run before anything is stored;
 * - the CV (and optional cover letter) are checked by size, name and file signature, then stored
 *   in the private application-files collection (R2 in production);
 * - the recipient is resolved here and is never part of any response.
 */

export const APPLY_PATH = '/:id/apply'
export const APPLICATION_FILE_DOWNLOAD_PATH = '/download/:id'

/** Files accepted for a CV or cover letter: extension -> the signatures its bytes may start with. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const FILE_TYPES: Record<string, { mime: string; signatures: number[][] }> = {
  doc: { mime: 'application/msword', signatures: [OLE] },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    signatures: [[0x50, 0x4b, 0x03, 0x04]],
  },
  pdf: { mime: 'application/pdf', signatures: [[0x25, 0x50, 0x44, 0x46, 0x2d]] },
}

export const APPLICATION_EVENTS = {
  /** Copy to the site admin (per-tenant setting, vwok on). */
  admin: 'application.admin-copy',
  /** The application itself, to the employer. */
  applicant: 'application.copy',
  employer: 'application.received',
} as const

export type ApplicationEmailEvent = (typeof APPLICATION_EVENTS)[keyof typeof APPLICATION_EVENTS]

/**
 * The seam to the email engine. The signature matches `sendTemplate(event, doc)` (PJ-50), which
 * does the template lookup, the per-event switch, the redirect and the log; `doc.to` is the
 * recipient. Bodies and file links are variables only: the email log never stores them.
 */
export type SendApplicationEmail = (
  event: ApplicationEmailEvent,
  doc: ApplicationEmailDoc,
) => Promise<unknown>

export type ApplicationEmailDoc = {
  applicantEmail: string
  applicantName: string
  applicantPhone?: string
  applicationId: number | string
  /** Signed, expiring links. Only the employer and admin emails carry them. */
  coverLetterLink?: string
  cvLink?: string
  jobId: number | string
  jobTitle: string
  linksExpireAt?: string
  message?: string
  organisationName?: string
  tenantId: number | string
  to: string
}

export type ApplyOptions = {
  /** How long the employer's file links work. Defaults to 7 days. */
  fileLinkTtlSeconds?: number
  rateLimiter?: ((req: PayloadRequest) => RateLimiter | undefined) | RateLimiter
  /** Without it the application is stored and nothing is emailed. */
  sendEmail?: SendApplicationEmail
  slugs?: PayloadJobsCollectionSlugs
  tenantsSlug?: string
  tenantScoped?: boolean
  turnstile?: {
    enabled?: boolean
    secret?: () => null | string | undefined
    verify?: TurnstileVerifier
  }
  usersSlug?: string
}

const DEFAULT_LINK_TTL_SECONDS = 7 * 24 * 60 * 60
const MAX_NAME = 200
const MAX_PHONE = 40
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HTML_TAG = /<\/?[a-z!][^>]*>/i

export type ApplyFieldError = { field: string; message: string }

export type ApplyInput = {
  consent: boolean
  coverLetter: File | null
  cv: File | null
  email: string
  message: string
  name: string
  phone: string
}

const extensionOf = (name: string): string => name.split('.').pop()?.toLowerCase() ?? ''

/** Check the first bytes of a file against what its extension claims. */
export const fileSignatureMatches = (extension: string, bytes: Uint8Array): boolean =>
  (FILE_TYPES[extension]?.signatures ?? []).some((signature) =>
    signature.every((byte, index) => bytes[index] === byte),
  )

/** Why a CV or cover letter is refused, or `null` when it is fine. Reads only the first bytes. */
export const fileProblem = async (file: File, label: string): Promise<null | string> => {
  const extension = extensionOf(file.name)

  if (!FILE_TYPES[extension]) return `${label} must be a PDF, DOC or DOCX file.`
  if (file.size === 0) return `${label} is empty.`
  if (file.size > APPLICATION_FILE_MAX_BYTES) return `${label} can be at most 10 MB.`

  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  if (!fileSignatureMatches(extension, head)) return `${label} is not a valid ${extension.toUpperCase()} file.`

  return null
}

const textField = (form: FormData, name: string): string => {
  const value = form.get(name)

  return typeof value === 'string' ? value.trim() : ''
}

const fileField = (form: FormData, name: string): File | null => {
  const value = form.get(name)

  return value instanceof File && (value.size > 0 || value.name) ? value : null
}

export const readApplyForm = (form: FormData): ApplyInput => ({
  consent: ['1', 'on', 'true', 'yes'].includes(textField(form, 'consent').toLowerCase()),
  coverLetter: fileField(form, 'coverLetter'),
  cv: fileField(form, 'cv'),
  email: textField(form, 'email').toLowerCase(),
  message: textField(form, 'message'),
  name: textField(form, 'name'),
  phone: textField(form, 'phone'),
})

/** Every problem with an application, in field order. Pure, so it is tested without a server. */
export const applyErrors = async (input: ApplyInput): Promise<ApplyFieldError[]> => {
  const errors: ApplyFieldError[] = []

  if (!input.name) errors.push({ field: 'name', message: 'Enter your name.' })
  else if (input.name.length > MAX_NAME) errors.push({ field: 'name', message: 'Your name is too long.' })

  if (!input.email || input.email.length > 254 || !EMAIL.test(input.email)) {
    errors.push({ field: 'email', message: 'Enter a valid email address.' })
  }

  if (input.phone.length > MAX_PHONE) errors.push({ field: 'phone', message: 'The phone number is too long.' })

  if (input.message.length > APPLICATION_MESSAGE_MAX_LENGTH) {
    errors.push({ field: 'message', message: `The message can be at most ${APPLICATION_MESSAGE_MAX_LENGTH} characters.` })
  } else if (HTML_TAG.test(input.message)) {
    errors.push({ field: 'message', message: 'The message is plain text: remove any HTML or formatting.' })
  }

  if (!input.cv) errors.push({ field: 'cv', message: 'Attach your CV.' })
  else {
    const problem = await fileProblem(input.cv, 'Your CV')
    if (problem) errors.push({ field: 'cv', message: problem })
  }

  if (input.coverLetter) {
    const problem = await fileProblem(input.coverLetter, 'Your cover letter')
    if (problem) errors.push({ field: 'coverLetter', message: problem })
  }

  if (!input.consent) errors.push({ field: 'consent', message: 'You need to agree to the privacy policy.' })

  return errors
}

/* -------------------------------------------------------------------------- */
/* Signed, expiring file links                                                 */
/* -------------------------------------------------------------------------- */

const toBase64Url = (bytes: ArrayBuffer): string => {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const hmacKey = (secret: string, usage: KeyUsage[]): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(`application-file-link:${secret}`), { hash: 'SHA-256', name: 'HMAC' }, false, usage)

const signedPayload = (fileId: number | string, expiresAt: number): string => `${String(fileId)}.${expiresAt}`

/** A signature over the file id and the expiry (seconds since the epoch). */
export const signFileLink = async ({
  expiresAt,
  fileId,
  secret,
}: {
  expiresAt: number
  fileId: number | string
  secret: string
}): Promise<string> =>
  toBase64Url(
    await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), new TextEncoder().encode(signedPayload(fileId, expiresAt))),
  )

export const verifyFileLink = async ({
  expiresAt,
  fileId,
  now = Date.now(),
  secret,
  signature,
}: {
  expiresAt: number
  fileId: number | string
  now?: number
  secret: string
  signature: string
}): Promise<boolean> => {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 <= now) return false

  const expected = await signFileLink({ expiresAt, fileId, secret })
  if (expected.length !== signature.length) return false

  // Compare in constant time: XOR every character, then look at the total.
  let diff = 0
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index)
  }

  return diff === 0
}

/** `https://cms.example/api/application-files/download/12?exp=...&sig=...` */
export const fileLinkURL = async ({
  expiresAt,
  fileId,
  filesSlug = APPLICATION_FILES_SLUG,
  origin,
  secret,
}: {
  expiresAt: number
  fileId: number | string
  filesSlug?: string
  origin: string
  secret: string
}): Promise<string> => {
  const signature = await signFileLink({ expiresAt, fileId, secret })

  return `${origin}/api/${filesSlug}/download/${encodeURIComponent(String(fileId))}?exp=${expiresAt}&sig=${signature}`
}

/* -------------------------------------------------------------------------- */
/* Recipient                                                                   */
/* -------------------------------------------------------------------------- */

const cleanEmail = (value: unknown): null | string =>
  typeof value === 'string' && EMAIL.test(value.trim()) ? value.trim() : null

/**
 * Where an application goes: the job's own address (legacy jr_fx_apps_recipient_address), else
 * the organisation's owner. Resolved on the server and never sent to the browser.
 */
export const applicationRecipient = async ({
  job,
  organisationContact,
}: {
  job: { applicationsRecipient?: unknown }
  organisationContact: () => Promise<null | string | undefined>
}): Promise<null | string> =>
  cleanEmail(job.applicationsRecipient) ?? cleanEmail(await organisationContact())

/* -------------------------------------------------------------------------- */
/* Endpoint                                                                    */
/* -------------------------------------------------------------------------- */

const ERRORS = {
  applyOffline: { code: 'apply_offline', message: 'This job does not take online applications.', status: 409 },
  invalidBody: { code: 'invalid_request', message: 'The request body is not valid.', status: 400 },
  invalidSiteKey: { code: 'invalid_site_key', message: 'A valid site key is required.', status: 401 },
  jobClosed: { code: 'job_closed', message: 'This job is no longer accepting applications.', status: 409 },
  notConfigured: { code: 'apply_not_configured', message: 'The apply endpoint is not configured.', status: 500 },
  notFound: { code: 'not_found', message: 'This job does not exist.', status: 404 },
  noRecipient: {
    code: 'apply_not_configured',
    message: 'This job cannot take applications right now.',
    status: 409,
  },
  signInRequired: { code: 'sign_in_required', message: 'Sign in to apply for this job.', status: 401 },
  tooManyRequests: { code: 'too_many_requests', message: 'Too many attempts. Try again in a minute.', status: 429 },
  turnstile: { code: 'turnstile_failed', message: 'The verification did not pass. Reload the page and try again.', status: 400 },
} as const

type JobDoc = {
  applicationsRecipient?: null | string
  applyOnline?: boolean | null
  expiresAt?: null | string
  id: number | string
  organisation?: unknown
  status?: null | string
  tenant?: unknown
  title?: null | string
}

type TenantDoc = AccountTenant & {
  accountRequiredToApply?: boolean | null
  adminEmail?: null | string
}

const idOf = (value: unknown): null | number | string => {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return idOf((value as { id?: unknown }).id)

  return value as number | string
}

const remoteIp = (req: PayloadRequest): null | string =>
  req.headers.get('cf-connecting-ip')?.trim() || req.headers.get('x-end-user-ip')?.trim() || null

const isLive = (job: JobDoc, now: Date): boolean =>
  job.status === 'published' && (!job.expiresAt || Date.parse(job.expiresAt) > now.getTime())

const toUpload = async (file: File) => {
  const extension = extensionOf(file.name)

  return {
    data: Buffer.from(await file.arrayBuffer()),
    mimetype: FILE_TYPES[extension]!.mime,
    name: file.name.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || `file.${extension}`,
    size: file.size,
  }
}

export const applyEndpoint = (options: ApplyOptions = {}): Endpoint => {
  const slugs = options.slugs ?? DEFAULT_PAYLOAD_JOBS_SLUGS
  const tenantsSlug = options.tenantsSlug ?? 'tenants'
  const usersSlug = options.usersSlug ?? 'users'
  const tenantScoped = options.tenantScoped ?? true
  const turnstile = {
    enabled: options.turnstile?.enabled ?? true,
    secret: options.turnstile?.secret,
    verify: options.turnstile?.verify ?? verifyTurnstileWithCloudflare,
  }

  return {
    handler: async (req) => {
      try {
        const siteKey = await resolveSiteKey(req)
        if (!siteKey) throw new AccountAuthError(ERRORS.invalidSiteKey)

        const rateTenant = { id: siteKey.tenantID }

        const rawId = req.routeParams?.id
        if (typeof rawId !== 'string' && typeof rawId !== 'number') throw new AccountAuthError(ERRORS.notFound)

        let form: FormData
        try {
          form = await (req as unknown as Request).formData()
        } catch {
          throw new AccountAuthError(ERRORS.invalidBody)
        }

        // A bot that fills the trap gets the same answer as a person and nothing is stored.
        if (textField(form, FORM_HONEYPOT_FIELD)) return accountResponse({ ok: true }, 202)

        // Limit per IP and per address (so rotating IPs does not get round it) before anything
        // costs money: Turnstile verification, database reads and file writes.
        const email = textField(form, 'email').toLowerCase()
        await enforceRateLimit({
          action: 'apply',
          identifier: EMAIL.test(email) && email.length <= 254 ? email : null,
          options: { rateLimiter: options.rateLimiter },
          req,
          tenant: rateTenant,
        })

        if (turnstile.enabled) {
          const secret = turnstile.secret?.()?.trim()
          if (!secret) throw new AccountAuthError(ERRORS.notConfigured)

          const token = textField(form, TURNSTILE_TOKEN_FIELD)
          if (!token) throw new AccountAuthError(ERRORS.turnstile)

          const result = await turnstile.verify({ remoteIp: remoteIp(req), secret, token })
          if (!result.success) throw new AccountAuthError(ERRORS.turnstile)
        }

        const input = readApplyForm(form)

        let job: JobDoc
        try {
          job = (await req.payload.findByID({
            collection: slugs.jobs as CollectionSlug,
            depth: 0,
            id: rawId,
            overrideAccess: true,
            req,
          })) as unknown as JobDoc
        } catch {
          throw new AccountAuthError(ERRORS.notFound)
        }

        const tenantID = idOf(job.tenant)
        // A site key applies to its own tenant's jobs only; another site's job is "not found".
        if (!siteKey.isAggregate && tenantID !== null && String(tenantID) !== String(siteKey.tenantID)) {
          throw new AccountAuthError(ERRORS.notFound)
        }

        if (!isLive(job, new Date())) throw new AccountAuthError(ERRORS.jobClosed)
        if (job.applyOnline === false) throw new AccountAuthError(ERRORS.applyOffline)

        const tenant = (await req.payload.findByID({
          collection: tenantsSlug as CollectionSlug,
          depth: 0,
          id: (tenantID ?? siteKey.tenantID) as number | string,
          overrideAccess: true,
        })) as unknown as TenantDoc

        const applicant = await resolveAccountUser(req, tenant, { tenantsSlug, usersSlug })
        if (tenant.accountRequiredToApply === true && !applicant) {
          throw new AccountAuthError(ERRORS.signInRequired)
        }

        const errors = await applyErrors(input)
        if (errors.length > 0) {
          return accountResponse({ error: { code: 'invalid_values', errors, message: errors[0]!.message } }, 400)
        }

        const organisationID = idOf(job.organisation)
        const organisation = organisationID === null
          ? null
          : ((await req.payload
              .findByID({ collection: slugs.organisations as CollectionSlug, depth: 0, id: organisationID, overrideAccess: true })
              .catch(() => null)) as null | { name?: null | string })

        const recipient = await applicationRecipient({
          job,
          organisationContact: async () => {
            if (organisationID === null) return null
            const { docs } = await req.payload.find({
              collection: usersSlug as CollectionSlug,
              depth: 0,
              limit: 1,
              overrideAccess: true,
              pagination: false,
              sort: 'createdAt',
              where: { and: [{ organisation: { equals: organisationID } }, { organisationRole: { equals: 'owner' } }] },
            })

            return (docs[0] as unknown as undefined | { email?: string })?.email
          },
        })
        // Refuse before storing anything: an application nobody receives is worse than an error.
        if (!recipient) throw new AccountAuthError(ERRORS.noRecipient)

        const scope = tenantScoped ? { tenant: tenant.id } : {}
        const created: { collection: string; id: number | string }[] = []

        const store = async (file: File): Promise<number | string> => {
          const doc = (await req.payload.create({
            collection: APPLICATION_FILES_SLUG as CollectionSlug,
            data: { ...(organisationID === null ? {} : { organisation: organisationID }), ...scope, ...(applicant ? { applicant: applicant.id } : {}) } as never,
            depth: 0,
            file: await toUpload(file),
            overrideAccess: true,
          })) as unknown as { id: number | string }
          created.push({ collection: APPLICATION_FILES_SLUG, id: doc.id })

          return doc.id
        }

        let application: { id: number | string }
        let cvId: number | string
        let coverLetterId: null | number | string = null
        try {
          cvId = await store(input.cv!)
          if (input.coverLetter) coverLetterId = await store(input.coverLetter)

          application = (await req.payload.create({
            collection: APPLICATIONS_SLUG as CollectionSlug,
            data: {
              ...scope,
              ...(applicant ? { applicant: applicant.id } : {}),
              consentAt: new Date().toISOString(),
              ...(coverLetterId === null ? {} : { coverLetter: coverLetterId }),
              cv: cvId,
              email: input.email,
              job: job.id,
              message: input.message,
              name: input.name,
              phone: input.phone,
            } as never,
            depth: 0,
            overrideAccess: true,
          })) as unknown as { id: number | string }
        } catch (error) {
          // Nothing half-stored: the files go if the application could not be written.
          for (const row of created) {
            await req.payload.delete({ collection: row.collection as CollectionSlug, id: row.id, overrideAccess: true }).catch(() => null)
          }
          throw error
        }

        await sendApplicationEmails({
          applicationId: application.id,
          coverLetterId,
          cvId,
          input,
          job,
          options,
          organisationName: organisation?.name ?? undefined,
          origin: new URL(req.url ?? 'http://localhost').origin,
          recipient,
          req,
          tenant,
        })

        return accountResponse({ ok: true }, 201)
      } catch (error) {
        if (error instanceof AccountAuthError) {
          return accountResponse({ error: { code: error.code, message: error.message } }, error.status, error.headers)
        }
        req.payload.logger.error({ err: error, msg: 'apply: submit failed' })

        return accountResponse({ error: { code: 'server_error', message: 'Something went wrong.' } }, 500)
      }
    },
    method: 'post',
    path: APPLY_PATH,
  }
}

const sendApplicationEmails = async ({
  applicationId,
  coverLetterId,
  cvId,
  input,
  job,
  options,
  organisationName,
  origin,
  recipient,
  req,
  tenant,
}: {
  applicationId: number | string
  coverLetterId: null | number | string
  cvId: number | string
  input: ApplyInput
  job: JobDoc
  options: ApplyOptions
  organisationName?: string
  origin: string
  recipient: string
  req: PayloadRequest
  tenant: TenantDoc
}): Promise<void> => {
  const send = options.sendEmail
  if (!send) return

  const ttl = options.fileLinkTtlSeconds ?? DEFAULT_LINK_TTL_SECONDS
  const expiresAt = Math.floor(Date.now() / 1000) + ttl
  const secret = req.payload.secret
  const link = (fileId: number | string) => fileLinkURL({ expiresAt, fileId, origin, secret })

  const base: Omit<ApplicationEmailDoc, 'to'> = {
    applicantEmail: input.email,
    applicantName: input.name,
    ...(input.phone ? { applicantPhone: input.phone } : {}),
    applicationId,
    jobId: job.id,
    jobTitle: job.title ?? '',
    ...(input.message ? { message: input.message } : {}),
    ...(organisationName ? { organisationName } : {}),
    tenantId: tenant.id,
  }
  const withLinks: Omit<ApplicationEmailDoc, 'to'> = {
    ...base,
    cvLink: await link(cvId),
    ...(coverLetterId === null ? {} : { coverLetterLink: await link(coverLetterId) }),
    linksExpireAt: new Date(expiresAt * 1000).toISOString(),
  }

  const adminEmail = cleanEmail(tenant.adminEmail)
  const emails: [ApplicationEmailEvent, ApplicationEmailDoc][] = [
    [APPLICATION_EVENTS.employer, { ...withLinks, to: recipient }],
    [APPLICATION_EVENTS.applicant, { ...base, to: input.email }],
    ...(adminEmail ? ([[APPLICATION_EVENTS.admin, { ...withLinks, to: adminEmail }]] as [ApplicationEmailEvent, ApplicationEmailDoc][]) : []),
  ]

  // One failed email never undoes a stored application, and the log line carries no address.
  for (const [event, doc] of emails) {
    try {
      await send(event, doc)
    } catch (error) {
      req.payload.logger.error({ err: error, event, msg: 'apply: email failed' })
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Signed download                                                             */
/* -------------------------------------------------------------------------- */

type UploadHandler = (
  req: PayloadRequest,
  args: { headers?: Headers; params: { clientUploadContext?: unknown; collection: string; filename: string } },
) => Promise<Response | void> | Response | void

/**
 * `GET /api/<application-files>/download/:id?exp=&sig=`: the link in the employer's email. The
 * signature names the file and the expiry, so it cannot be reused for another file. The bytes
 * come from the collection's storage handler (R2 in production), and the answer is never cached.
 */
export const applicationFileDownloadEndpoint = ({ filesSlug = APPLICATION_FILES_SLUG }: { filesSlug?: string } = {}): Endpoint => ({
  handler: async (req) => {
    const notFound = () => Response.json({ error: 'not_found' }, { headers: { 'cache-control': 'no-store' }, status: 404 })

    const id = req.routeParams?.id
    const url = new URL(req.url ?? 'http://localhost')
    const expiresAt = Number(url.searchParams.get('exp'))
    const signature = url.searchParams.get('sig') ?? ''
    if ((typeof id !== 'string' && typeof id !== 'number') || !signature) return notFound()

    const valid = await verifyFileLink({ expiresAt, fileId: id, secret: req.payload.secret, signature })
    if (!valid) return notFound()

    const file = (await req.payload
      .findByID({ collection: filesSlug as CollectionSlug, depth: 0, id, overrideAccess: true })
      .catch(() => null)) as null | { filename?: null | string }
    if (!file?.filename) return notFound()

    const handlers = (req.payload.collections[filesSlug as CollectionSlug]?.config.upload as { handlers?: UploadHandler[] } | undefined)?.handlers ?? []
    for (const handler of handlers) {
      const response = await handler(req, { headers: new Headers(), params: { collection: filesSlug, filename: file.filename } })
      if (response instanceof Response) {
        const headers = new Headers(response.headers)
        headers.set('cache-control', 'private, no-store')
        headers.set('content-disposition', `attachment; filename="${file.filename.replace(/"/g, '')}"`)
        headers.set('x-content-type-options', 'nosniff')

        return new Response(response.body, { headers, status: response.status })
      }
    }

    return notFound()
  },
  method: 'get',
  path: APPLICATION_FILE_DOWNLOAD_PATH,
})
