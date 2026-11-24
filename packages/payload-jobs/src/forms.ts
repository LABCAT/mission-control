import {
  type CollectionSlug,
  type Endpoint,
  type Payload,
  type PayloadRequest,
  type TaskConfig,
  type TaskSlug,
} from 'payload'

import {
  AccountAuthError,
  accountResponse,
  enforceRateLimit,
  resolveAccountTenant,
  type AccountTenant,
} from './account-auth'
import type { RateLimiter } from './rate-limit'

/**
 * Public form submissions (PJ-102). The host owns the Payload form-builder collections; this
 * module owns the one write path they accept:
 *
 * - the visitor's site posts here with its site key, so the tenant is never taken from input;
 * - Turnstile and a honeypot are checked before anything is written;
 * - the submission is created with `overrideAccess`, which is also what runs the form
 *   builder's email hook, so the notification leaves through the CMS email path;
 * - a tenant whose retention is 0 gets the email and no stored row.
 *
 * Direct writes to the submissions collection stay closed (`create: () => false` in the host
 * config), so this endpoint is the only way in and the checks cannot be skipped.
 */

/** Per-tenant retention setting: days to keep a submission; 0 means "email only, store none". */
export const FORM_RETENTION_FIELD = 'formRetentionDays'
export const DEFAULT_FORM_RETENTION_DAYS = 90
export const MAX_FORM_RETENTION_DAYS = 3650

/** Path under the tenants collection: `POST /api/tenants/:slug/forms/submit`. */
export const FORM_SUBMIT_PATH = '/:slug/forms/submit'

/** The field Turnstile puts its token in, and the block renders. */
export const TURNSTILE_TOKEN_FIELD = 'cf-turnstile-response'

/** The block's hidden bot trap. A person never sees it, so any value means a bot. */
export const FORM_HONEYPOT_FIELD = 'rp-website'

/** The task that deletes submissions past their tenant's retention. */
export const PURGE_FORM_SUBMISSIONS_TASK = 'purge-form-submissions'

const DAY_MS = 24 * 60 * 60 * 1000

/** The retention in days read from a tenant (or the settings global). */
export const formRetentionDays = (settings: Record<string, unknown> | null | undefined): number => {
  const value = settings?.[FORM_RETENTION_FIELD]

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_FORM_RETENTION_DAYS
  }

  return Math.min(MAX_FORM_RETENTION_DAYS, Math.floor(value))
}

/**
 * The instant before which a submission is past its retention. 0 days gives `now`, so nothing
 * stored stays stored: turning the setting to 0 empties the collection on the next run.
 */
export const formRetentionCutoff = (days: number, now: Date = new Date()): Date =>
  new Date(now.getTime() - formRetentionDays({ [FORM_RETENTION_FIELD]: days }) * DAY_MS)

type FormFieldDefinition = {
  blockType?: string
  label?: null | string
  /** The message block's rich text; unused here, present so a form document fits the type. */
  message?: unknown
  name?: null | string
  options?: { label?: null | string; value?: null | string }[] | null
  required?: boolean | null
}

export type FormDefinition = {
  fields?: FormFieldDefinition[] | null
  id: number | string
}

/** The field kinds that store an answer. A message block is prose, not a value. */
const ANSWERED_KINDS = new Set([
  'checkbox',
  'country',
  'date',
  'email',
  'number',
  'radio',
  'select',
  'state',
  'text',
  'textarea',
])

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const empty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0)

export type FormValueError = { message: string; path: string }

/**
 * Check the submitted answers against the form definition. Unknown keys are ignored rather
 * than stored, so a visitor cannot add fields (or a tenant id) to the document.
 */
export const formValueErrors = (
  form: FormDefinition,
  values: Record<string, unknown>,
): FormValueError[] => {
  const errors: FormValueError[] = []

  for (const field of form.fields ?? []) {
    if (!field || typeof field !== 'object') continue

    const kind = typeof field.blockType === 'string' ? field.blockType : ''
    const name = typeof field.name === 'string' ? field.name.trim() : ''

    if (!name || !ANSWERED_KINDS.has(kind)) continue

    const value = values[name]
    const label = field.label?.trim() || name

    if (field.required === true && empty(value)) {
      errors.push({ message: `${label} is required`, path: name })
      continue
    }

    if (empty(value)) continue

    if (kind === 'email' && !(typeof value === 'string' && EMAIL.test(value.trim()))) {
      errors.push({ message: `${label} must be an email address`, path: name })
    }

    if (kind === 'number' && !Number.isFinite(Number(value))) {
      errors.push({ message: `${label} must be a number`, path: name })
    }

    if ((kind === 'select' || kind === 'radio') && Array.isArray(field.options)) {
      const allowed = field.options.map((option) => String(option?.value ?? ''))
      if (!allowed.includes(String(value))) {
        errors.push({ message: `${label} is not one of the choices`, path: name })
      }
    }
  }

  return errors
}

/** The `submissionData` rows for the form builder, in the order the form shows them. */
export const formSubmissionData = (
  form: FormDefinition,
  values: Record<string, unknown>,
): { field: string; value: string }[] => {
  const rows: { field: string; value: string }[] = []

  for (const field of form.fields ?? []) {
    if (!field || typeof field !== 'object') continue

    const kind = typeof field.blockType === 'string' ? field.blockType : ''
    const name = typeof field.name === 'string' ? field.name.trim() : ''
    if (!name || !ANSWERED_KINDS.has(kind)) continue

    const value = values[name]
    if (empty(value)) continue

    rows.push({ field: name, value: kind === 'checkbox' ? 'true' : String(value) })
  }

  return rows
}

export type TurnstileVerifyArgs = {
  remoteIp?: null | string
  secret: string
  token: string
}

export type TurnstileVerifyResult = {
  errorCodes?: string[]
  success: boolean
}

export type TurnstileVerifier = (args: TurnstileVerifyArgs) => Promise<TurnstileVerifyResult>

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/** Ask Cloudflare whether a Turnstile token is genuine. Failure is always "not verified". */
export const verifyTurnstileWithCloudflare: TurnstileVerifier = async ({
  remoteIp,
  secret,
  token,
}) => {
  try {
    const body = new FormData()
    body.set('secret', secret)
    body.set('response', token)
    if (remoteIp) body.set('remoteip', remoteIp)

    const response = await fetch(TURNSTILE_VERIFY_URL, { body, method: 'POST' })
    if (!response.ok) return { success: false }

    const result = (await response.json()) as {
      'error-codes'?: string[]
      success?: boolean
    }

    return { errorCodes: result['error-codes'], success: result.success === true }
  } catch {
    return { success: false }
  }
}

/** A formatted form email, as the form builder hands it to `beforeEmail`. */
export type FormEmail = {
  bcc?: string
  cc?: string
  from: string
  html: string
  replyTo: string
  subject: string
  to: string
}

/** The tenant fields the notification needs. */
export type FormEmailTenant = {
  adminEmail?: null | string
  emailFromAddress?: null | string
  emailFromName?: null | string
}

const addressOf = ({ emailFromAddress, emailFromName }: FormEmailTenant): string => {
  const address = emailFromAddress?.trim() ?? ''
  const name = emailFromName?.trim() ?? ''

  return name && address ? `${name} <${address}>` : address
}

/**
 * Send the notification as the tenant, never as a hardcoded sender: the From comes from the
 * tenant's email settings, and an email with no recipient goes to the tenant's admin address.
 * An email that already names a From keeps it, so an editor who sets one in the form keeps it.
 */
export const withTenantSender = (emails: FormEmail[], tenant: FormEmailTenant): FormEmail[] => {
  const from = addressOf(tenant)
  const adminEmail = tenant.adminEmail?.trim() ?? ''

  return emails.map((email) => ({
    ...email,
    ...(from ? { from } : {}),
    ...(email.to?.trim() || !adminEmail ? {} : { to: adminEmail }),
  }))
}

/** One row of a form's `emails` array, as the form builder reads it. */
export type FormNotification = {
  emailFrom?: null | string
  emailTo?: null | string
  message?: unknown
  subject?: null | string
}

const lexicalParagraph = (text: string) => ({
  children: [{ text, type: 'text', version: 1 }],
  direction: null,
  format: '',
  indent: 0,
  type: 'paragraph',
  version: 1,
})

const lexicalDocument = (paragraphs: string[]) => ({
  root: {
    children: paragraphs.map(lexicalParagraph),
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

/**
 * A notification for a form that has none. Without one the form builder sends nothing, so an
 * editor who never visited the Emails tab would collect submissions silently. The subject is
 * the form's title and the body lists the answers, in form order, using the form builder's
 * `{{name}}` placeholders.
 */
export const defaultFormNotification = (form: {
  fields?: FormFieldDefinition[] | null
  title?: null | string
}): FormNotification => {
  const answers = (form.fields ?? [])
    .filter((field) => field && ANSWERED_KINDS.has(field.blockType ?? '') && field.name)
    .map((field) => `${field.label?.trim() || field.name}: {{${field.name}}}`)

  return {
    emailTo: '',
    message: lexicalDocument(['A new form submission arrived.', ...answers]),
    subject: form.title?.trim() || 'New form submission',
  }
}

/**
 * Give a form one notification when it has none. Runs on every save, so a form created before
 * this existed gets one the next time it is opened and saved.
 */
export const ensureFormNotification = <T extends { emails?: null | FormNotification[] }>(
  data: T,
): T =>
  data.emails && data.emails.length > 0
    ? data
    : { ...data, emails: [defaultFormNotification(data as { fields?: null | FormFieldDefinition[] | null; title?: null | string })] }

export type FormEmailHookArgs = {
  data?: null | Record<string, unknown>
  req: PayloadRequest
}

/**
 * The form builder's `beforeEmail` hook: send each notification as the tenant that owns the
 * submission. The tenant comes from the submission row (set from the site key, never from the
 * visitor), so one CMS with many sites sends each site's mail as that site.
 */
export const formEmailSender =
  ({ tenantsSlug = 'tenants' }: { tenantsSlug?: string } = {}) =>
  async (emails: FormEmail[], { data, req }: FormEmailHookArgs): Promise<FormEmail[]> => {
    const ref = data?.tenant
    const tenantID = ref && typeof ref === 'object' ? (ref as { id: unknown }).id : ref

    if (tenantID === null || tenantID === undefined || tenantID === '') return emails

    const tenant = (await req.payload.findByID({
      collection: tenantsSlug as CollectionSlug,
      depth: 0,
      id: tenantID as number | string,
      overrideAccess: true,
    })) as unknown as FormEmailTenant

    return withTenantSender(emails, tenant)
  }

export type FormTurnstileOptions = {
  /** Set to `false` only where another layer already checks bots. Defaults to on. */
  enabled?: boolean
  /**
   * The secret key, read per request so a Worker secret can be passed as a getter. A missing
   * secret fails closed: an unverified public form is worse than an unavailable one.
   */
  secret?: () => null | string | undefined
  /** Swappable for tests and for a verifier with a timeout of its own. */
  verify?: TurnstileVerifier
}

export type FormsOptions = {
  /** The form-builder forms collection. Defaults to `forms`. */
  formsSlug?: string
  /** The form-builder submissions collection. Defaults to `form-submissions`. */
  submissionsSlug?: string
  /** Tenant-scoped (multi-tenant) mode; the tenant field is set from the site key. */
  tenantScoped?: boolean
  /** Tenants collection, multi-tenant mode only. */
  tenantsSlug?: string
  /** Rate limiter, as for the account endpoints. */
  rateLimiter?: AccountFormsRateLimiter
  turnstile?: FormTurnstileOptions
}

type AccountFormsRateLimiter =
  | ((req: PayloadRequest) => RateLimiter | undefined)
  | RateLimiter
  | undefined

type ResolvedFormsOptions = {
  formsSlug: string
  rateLimiter: AccountFormsRateLimiter
  submissionsSlug: string
  tenantScoped: boolean
  tenantsSlug: string
  turnstile: Required<Omit<FormTurnstileOptions, 'secret'>> & Pick<FormTurnstileOptions, 'secret'>
}

export const resolveFormsOptions = (options: FormsOptions = {}): ResolvedFormsOptions => ({
  formsSlug: options.formsSlug ?? 'forms',
  rateLimiter: options.rateLimiter,
  submissionsSlug: options.submissionsSlug ?? 'form-submissions',
  tenantScoped: options.tenantScoped ?? true,
  tenantsSlug: options.tenantsSlug ?? 'tenants',
  turnstile: {
    enabled: options.turnstile?.enabled ?? true,
    secret: options.turnstile?.secret,
    verify: options.turnstile?.verify ?? verifyTurnstileWithCloudflare,
  },
})

const ERRORS = {
  formNotFound: { code: 'form_not_found', message: 'This form does not exist.', status: 404 },
  invalidBody: { code: 'invalid_request', message: 'The request body is not valid.', status: 400 },
  notConfigured: {
    code: 'form_not_configured',
    message: 'The form endpoint is not configured.',
    status: 500,
  },
  turnstile: {
    code: 'turnstile_failed',
    message: 'The verification did not pass. Reload the page and try again.',
    status: 400,
  },
} as const

/** Keys the endpoint reads itself; everything else in a form post is a field answer. */
const RESERVED_KEYS = new Set([
  FORM_HONEYPOT_FIELD,
  TURNSTILE_TOKEN_FIELD,
  'form',
  'turnstileToken',
  'values',
])

export type FormSubmissionBody = {
  form: unknown
  honeypot: unknown
  turnstileToken: unknown
  values: Record<string, unknown>
}

/**
 * Split a submission into the fields the endpoint reads and the answers it stores. Accepts the
 * JSON the site sends and, directly, the browser's own form post, so a site can proxy the
 * request verbatim. `values` wins when a JSON body has one, so a field named `form` is rare
 * rather than ambiguous.
 */
export const parseFormSubmission = (
  contentType: null | string,
  raw: string,
): FormSubmissionBody => {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase()

  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    const params = new URLSearchParams(raw)
    const values: Record<string, unknown> = {}

    for (const [key, value] of params) {
      if (!RESERVED_KEYS.has(key)) values[key] = value
    }

    return {
      form: params.get('form'),
      honeypot: params.get(FORM_HONEYPOT_FIELD),
      turnstileToken: params.get('turnstileToken') ?? params.get(TURNSTILE_TOKEN_FIELD),
      values,
    }
  }

  let body: unknown

  try {
    body = JSON.parse(raw)
  } catch {
    throw new AccountAuthError(ERRORS.invalidBody)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AccountAuthError(ERRORS.invalidBody)
  }

  const document = body as Record<string, unknown>
  const explicit =
    document.values && typeof document.values === 'object' && !Array.isArray(document.values)
      ? (document.values as Record<string, unknown>)
      : null

  return {
    form: document.form,
    honeypot: document[FORM_HONEYPOT_FIELD],
    turnstileToken:
      document.turnstileToken ??
      document[TURNSTILE_TOKEN_FIELD.replace(/-/g, '_')] ??
      document[TURNSTILE_TOKEN_FIELD],
    values:
      explicit ??
      Object.fromEntries(Object.entries(document).filter(([key]) => !RESERVED_KEYS.has(key))),
  }
}

const remoteIp = (req: PayloadRequest): null | string =>
  req.headers.get('cf-connecting-ip')?.trim() ||
  req.headers.get('x-end-user-ip')?.trim() ||
  null


const tenantSettings = (settings: unknown): Record<string, unknown> =>
  (settings ?? {}) as Record<string, unknown>

/**
 * Find a form the tenant may use. A form from another site answers exactly like a missing one,
 * so a form id cannot be used to probe other sites.
 */
const findForm = async (
  req: PayloadRequest,
  options: ResolvedFormsOptions,
  tenant: AccountTenant,
  id: unknown,
): Promise<FormDefinition> => {
  if (id === undefined || id === null || id === '') throw new AccountAuthError(ERRORS.formNotFound)

  const { docs } = await req.payload.find({
    collection: options.formsSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    where: options.tenantScoped
      ? { and: [{ id: { equals: id as number | string } }, { tenant: { equals: tenant.id } }] }
      : { id: { equals: id as number | string } },
  })

  const form = docs[0] as unknown as FormDefinition | undefined
  if (!form) throw new AccountAuthError(ERRORS.formNotFound)

  return form
}

/** Deletes one stored submission without its email: the email already went out on create. */
const forgetSubmission = async (
  req: PayloadRequest,
  options: ResolvedFormsOptions,
  id: number | string,
): Promise<void> => {
  await req.payload.delete({
    collection: options.submissionsSlug as CollectionSlug,
    id,
    overrideAccess: true,
    req,
  })
}

const submit: (
  options: ResolvedFormsOptions,
) => NonNullable<Endpoint['handler']> = (options) => async (req) => {
  try {
    const tenant = await resolveAccountTenant(req, { tenantsSlug: options.tenantsSlug })

    await enforceRateLimit({
      action: 'form-submit',
      options: { rateLimiter: options.rateLimiter },
      req,
      tenant,
    })

    const raw = await req.text?.()
    const body = parseFormSubmission(req.headers.get('content-type'), raw ?? '')

    // A bot that fills the trap gets the same answer as a person and nothing is stored.
    if (!empty(body.honeypot)) return accountResponse({ ok: true }, 202)

    if (options.turnstile.enabled) {
      const secret = options.turnstile.secret?.()?.trim()
      if (!secret) throw new AccountAuthError(ERRORS.notConfigured)

      const token = typeof body.turnstileToken === 'string' ? body.turnstileToken.trim() : ''
      if (!token) throw new AccountAuthError(ERRORS.turnstile)

      const result = await options.turnstile.verify({
        remoteIp: remoteIp(req),
        secret,
        token,
      })
      if (!result.success) throw new AccountAuthError(ERRORS.turnstile)
    }

    const form = await findForm(req, options, tenant, body.form)

    const values = body.values

    const errors = formValueErrors(form, values)
    if (errors.length > 0) {
      throw new AccountAuthError({
        code: 'invalid_values',
        message: errors[0]!.message,
        status: 400,
      })
    }

    // The create runs on the local API (no `req`): the multi-tenant plugin only accepts a
    // tenant assignment from a local call or a signed-in member of that tenant, and this
    // request is neither. The tenant was already fixed from the site key above.
    const submission = (await req.payload.create({
      collection: options.submissionsSlug as CollectionSlug,
      data: {
        form: form.id,
        submissionData: formSubmissionData(form, values),
        ...(options.tenantScoped ? { tenant: tenant.id } : {}),
      } as never,
      depth: 0,
      overrideAccess: true,
    })) as unknown as { id: number | string }

    // 0 days means "email only": the create above ran the email hook, and the row goes now.
    if (formRetentionDays(tenantSettings(tenant)) === 0) {
      await forgetSubmission(req, options, submission.id)
    }

    return accountResponse({ ok: true })
  } catch (error) {
    if (error instanceof AccountAuthError) {
      // `retry-after` from the rate limiter must survive; `accountResponse` already sets
      // `cache-control: no-store` on every answer.
      return accountResponse(
        { error: { code: error.code, message: error.message } },
        error.status,
        error.headers,
      )
    }
    req.payload.logger.error({ err: error, msg: 'forms: submit failed' })

    return accountResponse(
      { error: { code: 'server_error', message: 'Something went wrong.' } },
      500,
    )
  }
}

/** The tenant-collection endpoints for the public form submission. */
export const formEndpoints = (incoming: FormsOptions = {}): Endpoint[] => {
  const options = resolveFormsOptions(incoming)

  return [{ handler: submit(options), method: 'post', path: FORM_SUBMIT_PATH }]
}

export type PurgeFormSubmissionsOptions = {
  batchSize?: number
  cron?: string
  queue?: string
  /** Ignored without a forms collection: the task only deletes submissions. */
  submissionsSlug?: string
  /** Single-tenant mode keeps the retention in the settings global. */
  settingsSlug?: string
  tenantScoped?: boolean
  tenantsSlug?: string
}

const deleteOlderThan = async (
  payload: Payload,
  {
    batchSize,
    collection,
    cutoff,
    tenantID,
  }: {
    batchSize: number
    collection: string
    cutoff: Date
    tenantID?: number | string
  },
): Promise<number> => {
  let deleted = 0

  for (;;) {
    const { docs } = await payload.find({
      collection: collection as CollectionSlug,
      depth: 0,
      limit: batchSize,
      overrideAccess: true,
      pagination: false,
      where: {
        and: [
          { createdAt: { less_than: cutoff.toISOString() } },
          ...(tenantID === undefined ? [] : [{ tenant: { equals: tenantID } }]),
        ],
      },
    })

    if (docs.length === 0) return deleted

    for (const doc of docs) {
      await payload.delete({
        collection: collection as CollectionSlug,
        id: doc.id,
        overrideAccess: true,
      })
      deleted += 1
    }

    if (docs.length < batchSize) return deleted
  }
}

/**
 * Delete form submissions past their tenant's retention. Each site's setting is read on every
 * run, so a change applies on the next tick; a setting of 0 empties the tenant's submissions.
 */
export const purgeFormSubmissionsTask = ({
  batchSize = 100,
  cron = '0 30 3 * * *',
  queue = 'hourly',
  settingsSlug = 'job-board-settings',
  submissionsSlug = 'form-submissions',
  tenantScoped = true,
  tenantsSlug = 'tenants',
}: PurgeFormSubmissionsOptions = {}): TaskConfig => ({
  slug: PURGE_FORM_SUBMISSIONS_TASK as TaskSlug,
  outputSchema: [
    { name: 'submissionsDeleted', type: 'number' },
    { name: 'tenantsChecked', type: 'number' },
  ],
  schedule: [{ cron, queue }],
  handler: async ({ req }) => {
    const now = new Date()
    let submissionsDeleted = 0
    let tenantsChecked = 0

    if (!tenantScoped) {
      const settings = await req.payload.findGlobal({
        slug: settingsSlug as never,
        depth: 0,
        overrideAccess: true,
        req,
      })
      const cutoff = formRetentionCutoff(formRetentionDays(tenantSettings(settings)), now)
      submissionsDeleted += await deleteOlderThan(req.payload, {
        batchSize,
        collection: submissionsSlug,
        cutoff,
      })

      return { output: { submissionsDeleted, tenantsChecked: 1 } }
    }

    const { docs: tenants } = await req.payload.find({
      collection: tenantsSlug as CollectionSlug,
      depth: 0,
      overrideAccess: true,
      pagination: false,
      req,
      where: { isAggregate: { not_equals: true } },
    })

    for (const tenant of tenants) {
      tenantsChecked += 1

      const cutoff = formRetentionCutoff(formRetentionDays(tenantSettings(tenant as never)), now)
      submissionsDeleted += await deleteOlderThan(req.payload, {
        batchSize,
        collection: submissionsSlug,
        cutoff,
        tenantID: tenant.id,
      })
    }

    return { output: { submissionsDeleted, tenantsChecked } }
  },
})
