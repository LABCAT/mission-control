import type { CollectionAfterChangeHook, CollectionSlug, Payload, PayloadRequest } from 'payload'

import { tenantIDOf } from '../catalog'
import { JOB_SYSTEM_CONTEXT } from '../job-status'
import { JOB_VIEWS_CONTEXT } from '../collections/jobs'
import { emailEngineConfig, sendTemplate, type SendTemplateOptions } from './send'

/**
 * Wires the job, order and organisation emails to the transitions that cause them (PJ-51).
 * Every email goes through `sendTemplate`; this file only decides WHICH events a change fires
 * and WHO gets them.
 *
 * Rules (decisions 19 Nov, "one email per action"):
 * - A job that reaches `pending` sends ONE "Job submitted" to the employer, with the order's
 *   details inside it, and one to the site admin. The order it created sends nothing of its own.
 * - An order that has no job (a credit pack) sends "Order created" to the owner and the admin.
 * - An order paid or cancelled later is a new action: one email to the owner.
 * - Anything that happens in the same request as the job was submitted or the order was created
 *   (published at once, paid at once) adds no second email.
 * - An invoice-me organisation's billing address gets a copy of the owner's order and
 *   submission emails.
 * - Each event has its own per-tenant switch (the email template's `enabled`), which
 *   `sendTemplate` honours and logs as `skipped`.
 *
 * Idempotency: a hook fires only on the transition itself (status or flag changing), and each
 * request remembers what it already sent (`SENT_CONTEXT`), so a repeated save sends nothing.
 */

export type NotificationEvent = {
  /** The record the email is about, kept in the log as a pointer. */
  linked: { collection: string; id: number | string }
  doc: Record<string, unknown>
  event: string
  /** Idempotency key: the same key is never sent twice in one request. */
  key: string
  to: string
}

export type Person = { email: string; firstName?: string }

export type OrderDetails = {
  currency?: null | string
  id: number | string
  paymentMethod?: null | string
  status?: null | string
  total?: null | number
}

export type NotificationContext = {
  adminEmail?: null | string
  /** The invoice-me organisation's billing address, when it has one. */
  billingEmail?: null | string
  /** The job's creator. */
  employer?: null | Person
  order?: null | OrderDetails
  organisationName?: null | string
  /** The organisation's owner. */
  owner?: null | Person
  /** Public link for the job or the page, when the host knows it. */
  url?: null | string
}

/** Notification keys sent in this request, so a repeated save sends nothing twice. */
export const SENT_CONTEXT = 'payloadJobsEmailSent'

/** Set to `[]` to hold emails until the transaction commits; `flushNotifications` sends them. */
export const EMAIL_DEFER_CONTEXT = 'payloadJobsDeferEmails'

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** "VUV 3,900" from minor units and a currency code. Falls back to the plain number. */
export const formatMoney = (amount: null | number | undefined, currency: null | string | undefined): string => {
  if (typeof amount !== 'number') return ''
  const code = currency ?? ''
  try {
    const format = new Intl.NumberFormat('en', { currency: code, style: 'currency' })
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2

    return format.format(amount / 10 ** digits)
  } catch {
    return code ? `${code} ${amount}` : String(amount)
  }
}

const orderVariables = (order: null | OrderDetails | undefined): Record<string, unknown> =>
  order
    ? {
        orderNumber: String(order.id),
        orderStatus: str(order.status),
        orderTotal: formatMoney(order.total, order.currency),
        paymentMethod: str(order.paymentMethod),
      }
    : { orderNumber: '', orderStatus: '', orderTotal: '', paymentMethod: '' }

const common = (ctx: NotificationContext): Record<string, unknown> => ({
  organisationName: ctx.organisationName ?? '',
})

/** The address list for an owner-facing email: the person, plus billing when it is a different one. */
const ownerAddresses = (person: null | Person | undefined, ctx: NotificationContext, withBilling: boolean): string[] => {
  const to: string[] = []
  if (person?.email) to.push(person.email)
  if (withBilling && ctx.billingEmail && !to.includes(ctx.billingEmail)) to.push(ctx.billingEmail)

  return to
}

const unique = (events: NotificationEvent[]): NotificationEvent[] => {
  const seen = new Set<string>()

  return events.filter((entry) => !seen.has(entry.key) && seen.add(entry.key))
}

type Doc = Record<string, unknown>

/** Job fields a bookkeeping write changes; an edit is any other change. */
const JOB_BOOKKEEPING = new Set([
  'createdAt', 'createdBy', 'expiresAt', 'id', 'legacyId', 'log', 'order', 'organisation', 'plan', 'publishedAt', 'slug', 'status', 'tenant', 'updatedAt', 'updatedBy', 'viewDays', 'views',
])

/** A value as JSON, with a populated relationship reduced to its id, so depth never reads as a change. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) && 'id' in item ? (item as { id: unknown }).id : item,
  )

export const changedJobKeys = (doc: Doc, previous: Doc): string[] => {
  const changed: string[] = []
  const keys = new Set([...Object.keys(doc), ...Object.keys(previous)])
  for (const key of keys) {
    if (JOB_BOOKKEEPING.has(key)) continue
    if (canonical(doc[key]) !== canonical(previous[key])) changed.push(key)
  }

  return changed
}

export const jobContentChanged = (doc: Doc, previous: Doc): boolean => changedJobKeys(doc, previous).length > 0

export type JobChange = {
  /** The save came from the system (checkout, approval, view counting), not an editor. */
  system?: boolean
}

/**
 * The emails a job save fires. `previous` is `null` on create.
 */
export const planJobEmails = (
  doc: Doc,
  previous: Doc | null,
  ctx: NotificationContext,
  change: JobChange = {},
): NotificationEvent[] => {
  const status = str(doc.status)
  const before = previous ? str(previous.status) : null
  const linked = { collection: 'jobs', id: doc.id as number | string }
  const base = {
    ...common(ctx),
    firstName: ctx.employer?.firstName ?? '',
    jobUrl: ctx.url ?? '',
    tenant: doc.tenant,
    title: str(doc.title),
  }
  const out: NotificationEvent[] = []

  if (status === 'pending' && before !== 'pending') {
    const withOrder = { ...base, ...orderVariables(ctx.order) }
    const key = `job-submitted:${String(doc.id)}`
    for (const to of ownerAddresses(ctx.employer ?? ctx.owner, ctx, true)) {
      out.push({ doc: { ...withOrder, employerEmail: to }, event: 'job-submitted', key: `${key}:${to}`, linked, to })
    }
    if (ctx.adminEmail) {
      out.push({ doc: { ...withOrder, adminEmail: ctx.adminEmail }, event: 'job-submitted-admin', key: `${key}:admin`, linked, to: ctx.adminEmail })
    }
  } else if (status === 'published' && before !== 'published') {
    // Published in the same action as the submission (a trusted employer, paid by credit):
    // the submission email is the one email.
    // An invoice-eligible organisation's billing address is told too, like on submission.
    for (const to of ownerAddresses(ctx.employer ?? ctx.owner, ctx, true)) {
      out.push({
        doc: { ...base, employerEmail: to },
        event: 'job-approved',
        key: `job-approved:${String(doc.id)}:${to}`,
        linked,
        to,
      })
    }
  } else if (status === 'expired' && before !== null && before !== 'expired') {
    for (const to of ownerAddresses(ctx.employer ?? ctx.owner, ctx, true)) {
      out.push({
        doc: { ...base, employerEmail: to },
        event: 'job-expired',
        key: `job-expired:${String(doc.id)}:${str(doc.expiresAt)}:${to}`,
        linked,
        to,
      })
    }
  } else if (
    status === 'pending' &&
    before === 'pending' &&
    previous &&
    !change.system &&
    ctx.adminEmail &&
    jobContentChanged(doc, previous)
  ) {
    out.push({
      doc: { ...base, adminEmail: ctx.adminEmail },
      event: 'job-edited-pending',
      // An edit is its own transition: each distinct save may notify, so key by the save time.
      key: `job-edited-pending:${String(doc.id)}:${str(doc.updatedAt)}`,
      linked,
      to: ctx.adminEmail,
    })
  }

  return unique(out)
}

export type OrderChange = { hasJobs: boolean }

export const planOrderEmails = (
  doc: Doc,
  previous: Doc | null,
  ctx: NotificationContext,
  change: OrderChange,
): NotificationEvent[] => {
  const status = str(doc.status)
  const before = previous ? str(previous.status) : null
  const linked = { collection: 'orders', id: doc.id as number | string }
  const order: OrderDetails = {
    currency: str(doc.currency) || null,
    id: doc.id as number | string,
    paymentMethod: str(doc.paymentMethod) || null,
    status,
    total: typeof doc.total === 'number' ? doc.total : null,
  }
  const vars = { ...common(ctx), ...orderVariables(order), firstName: ctx.owner?.firstName ?? '', tenant: doc.tenant }
  const invoice = order.paymentMethod === 'invoice'
  const out: NotificationEvent[] = []

  if (previous === null) {
    // An order that comes with a job is told by "Job submitted". Only an order alone (a credit
    // pack) has an email of its own.
    if (change.hasJobs) return []
    for (const to of ownerAddresses(ctx.owner, ctx, invoice)) {
      out.push({ doc: { ...vars, ownerEmail: to }, event: 'order-created', key: `order-created:${String(doc.id)}:${to}`, linked, to })
    }
    if (ctx.adminEmail) {
      out.push({ doc: { ...vars, adminEmail: ctx.adminEmail }, event: 'order-created-admin', key: `order-created:${String(doc.id)}:admin`, linked, to: ctx.adminEmail })
    }

    return unique(out)
  }

  if (status === before) return []
  const event = status === 'paid' ? 'order-paid' : status === 'cancelled' ? 'order-cancelled' : null
  if (!event) return []
  for (const to of ownerAddresses(ctx.owner, ctx, invoice)) {
    out.push({ doc: { ...vars, ownerEmail: to }, event, key: `${event}:${String(doc.id)}:${to}`, linked, to })
  }

  return unique(out)
}

export const planOrganisationEmails = (doc: Doc, previous: Doc | null, ctx: NotificationContext): NotificationEvent[] => {
  const linked = { collection: 'organisations', id: doc.id as number | string }
  const vars = { ...common(ctx), firstName: ctx.owner?.firstName ?? '', pageUrl: ctx.url ?? '', tenant: doc.tenant }
  const was = (field: string) => previous?.[field] === true
  const now = (field: string) => doc[field] === true
  const out: NotificationEvent[] = []

  if (now('listingRequested') && !was('listingRequested') && ctx.adminEmail) {
    out.push({
      doc: { ...vars, adminEmail: ctx.adminEmail },
      event: 'organisation-page-requested',
      key: `organisation-page-requested:${String(doc.id)}`,
      linked,
      to: ctx.adminEmail,
    })
  }
  if (now('pageEnabled') && !was('pageEnabled') && ctx.owner?.email) {
    out.push({
      doc: { ...vars, ownerEmail: ctx.owner.email },
      event: 'organisation-page-approved',
      key: `organisation-page-approved:${String(doc.id)}`,
      linked,
      to: ctx.owner.email,
    })
  }

  return unique(out)
}

// ---------------------------------------------------------------------------------------------
// Sending

const sentKeys = (req: PayloadRequest): Set<string> => {
  const existing = req.context[SENT_CONTEXT]
  if (existing instanceof Set) return existing as Set<string>
  const created = new Set<string>()
  req.context[SENT_CONTEXT] = created

  return created
}

/** Send one planned email. A failure is logged and swallowed: the save must not fail over mail. */
export const sendNotification = async (
  payload: Payload,
  notification: NotificationEvent,
  tenant: null | number | string,
): Promise<void> => {
  const options: SendTemplateOptions = {
    linked: notification.linked,
    to: notification.to,
    ...(tenant !== null ? { tenant } : {}),
  }
  try {
    await sendTemplate(payload, notification.event, notification.doc, options)
  } catch (error) {
    payload.logger.error({ err: error }, `payload-jobs: ${notification.event} email failed`)
  }
}

type Pending = { notification: NotificationEvent; tenant: null | number | string }

/**
 * Send what a hook planned, or hold it when the request is inside a transaction that may roll
 * back (checkout). Held emails go out in `flushNotifications` once the transaction has committed.
 */
export const dispatchNotifications = async (
  req: PayloadRequest,
  notifications: NotificationEvent[],
  tenant: null | number | string,
): Promise<void> => {
  const sent = sentKeys(req)
  const fresh = notifications.filter((entry) => !sent.has(entry.key))
  for (const entry of fresh) sent.add(entry.key)

  const deferred = req.context[EMAIL_DEFER_CONTEXT]
  if (Array.isArray(deferred)) {
    for (const notification of fresh) (deferred as Pending[]).push({ notification, tenant })

    return
  }
  for (const notification of fresh) await sendNotification(req.payload, notification, tenant)
}

/** Send the emails held while a transaction ran. Call once it has committed. */
export const flushNotifications = async (payload: Payload, held: readonly Pending[]): Promise<void> => {
  for (const { notification, tenant } of held) await sendNotification(payload, notification, tenant)
}

// ---------------------------------------------------------------------------------------------
// Loading what the plans need, and the hooks

export type NotificationHookOptions = {
  jobsSlug: string
  ordersSlug: string
  organisationsSlug: string
  tenancy: 'multi' | 'single'
  usersSlug: string
}

const personOf = (user: unknown): null | Person => {
  if (!user || typeof user !== 'object') return null
  const { email, firstName } = user as { email?: unknown; firstName?: unknown }
  if (typeof email !== 'string' || email === '') return null

  return { email, ...(typeof firstName === 'string' && firstName ? { firstName } : {}) }
}

const idOf = (value: unknown): null | number | string => tenantIDOf(value)

/** Payload stamps `createdBy` as `{ relationTo, value }`, where value is an id or a document. */
const creatorOf = (value: unknown): null | number | string =>
  value && typeof value === 'object' && 'value' in value ? idOf((value as { value: unknown }).value) : idOf(value)

const findDoc = async (req: PayloadRequest, collection: string, id: null | number | string): Promise<Doc | null> =>
  id === null
    ? null
    : ((await req.payload.findByID({
        collection: collection as CollectionSlug,
        depth: 0,
        disableErrors: true,
        id,
        overrideAccess: true,
        req,
      })) as unknown as Doc | null)

/** The owner of an organisation: its first member with the owner role. */
const ownerOf = async (req: PayloadRequest, options: NotificationHookOptions, organisationID: null | number | string): Promise<null | Person> => {
  if (organisationID === null) return null
  const { docs } = await req.payload.find({
    collection: options.usersSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    req,
    sort: 'id',
    where: { and: [{ organisation: { equals: organisationID } }, { organisationRole: { equals: 'owner' } }] },
  })

  return personOf(docs[0])
}

const loadContext = async (
  req: PayloadRequest,
  options: NotificationHookOptions,
  args: { organisationID: null | number | string; tenantID: null | number | string; orderID?: null | number | string; creatorID?: null | number | string },
): Promise<NotificationContext> => {
  const engine = emailEngineConfig(req.payload)
  const tenant =
    options.tenancy === 'multi'
      ? await findDoc(req, engine.tenantsSlug, args.tenantID)
      : ((await req.payload.findGlobal({ depth: 0, overrideAccess: true, req, slug: engine.settingsSlug as never })) as unknown as Doc)
  const organisation = await findDoc(req, options.organisationsSlug, args.organisationID)
  const order = await findDoc(req, options.ordersSlug, args.orderID ?? null)
  const creator = args.creatorID ? await findDoc(req, options.usersSlug, args.creatorID) : null
  const owner = await ownerOf(req, options, args.organisationID)
  const invoice = organisation?.canPayByInvoice === true
  const billing = typeof organisation?.billingEmail === 'string' && organisation.billingEmail ? organisation.billingEmail : null

  return {
    adminEmail: typeof tenant?.adminEmail === 'string' ? tenant.adminEmail : null,
    billingEmail: invoice ? billing : null,
    employer: personOf(creator) ?? owner,
    order: order
      ? {
          currency: str(order.currency) || null,
          id: order.id as number | string,
          paymentMethod: str(order.paymentMethod) || null,
          status: str(order.status) || null,
          total: typeof order.total === 'number' ? order.total : null,
        }
      : null,
    organisationName: typeof organisation?.name === 'string' ? organisation.name : null,
    owner,
  }
}

const tenantOf = (options: NotificationHookOptions, doc: Doc): null | number | string =>
  options.tenancy === 'multi' ? idOf(doc.tenant) : null

const guard = async (req: PayloadRequest, label: string, run: () => Promise<void>): Promise<void> => {
  try {
    await run()
  } catch (error) {
    req.payload.logger.error({ err: error }, `payload-jobs: ${label} email hook failed`)
  }
}

export const jobNotificationHook =
  (options: NotificationHookOptions): CollectionAfterChangeHook =>
  async ({ context, doc, operation, previousDoc, req }) => {
    // View counting runs through here constantly and never sends mail.
    if (context?.[JOB_VIEWS_CONTEXT]) return doc
    await guard(req, 'job', async () => {
      const previous = operation === 'create' ? null : (previousDoc as Doc)
      const ctx = await loadContext(req, options, {
        creatorID: creatorOf(doc.createdBy),
        orderID: idOf(doc.order),
        organisationID: idOf(doc.organisation),
        tenantID: tenantOf(options, doc),
      })
      const planned = planJobEmails(doc, previous, ctx, { system: context?.[JOB_SYSTEM_CONTEXT] === true })
      // One email per action: a job published in the request that submitted it, or that an order
      // being paid released, adds nothing.
      const sent = sentKeys(req)
      const orderID = idOf(doc.order)
      const covered = [...sent].some(
        (key) =>
          key.startsWith(`job-submitted:${String(doc.id)}:`) ||
          (orderID !== null && key.startsWith(`order-paid:${String(orderID)}:`)),
      )
      const kept = planned.filter((entry) => !(entry.event === 'job-approved' && covered))
      await dispatchNotifications(req, kept, tenantOf(options, doc))
    })

    return doc
  }

export const orderNotificationHook =
  (options: NotificationHookOptions): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    await guard(req, 'order', async () => {
      const previous = operation === 'create' ? null : (previousDoc as Doc)
      const created = sentKeys(req)
      // Paid in the request that created the order: the creation email already told them.
      if (previous && [...created].some((key) => key.startsWith(`order-created:${String(doc.id)}:`))) return
      const jobs = Array.isArray(doc.jobs) ? (doc.jobs as unknown[]) : []
      const ctx = await loadContext(req, options, {
        organisationID: idOf(doc.organisation),
        tenantID: tenantOf(options, doc),
      })
      const planned = planOrderEmails(doc, previous, ctx, { hasJobs: jobs.length > 0 })
      if (previous === null) {
        // Remember the order was created here even when it sent nothing (it has a job), so
        // being paid in the same request does not add a second email.
        created.add(`order-created:${String(doc.id)}:request`)
        if (jobs.length > 0) return
      }
      await dispatchNotifications(req, planned, tenantOf(options, doc))
    })

    return doc
  }

export const organisationNotificationHook =
  (options: NotificationHookOptions): CollectionAfterChangeHook =>
  async ({ doc, operation, previousDoc, req }) => {
    await guard(req, 'organisation', async () => {
      const previous = operation === 'create' ? null : (previousDoc as Doc)
      if (previous === null && doc.listingRequested !== true && doc.pageEnabled !== true) return
      const ctx = await loadContext(req, options, { organisationID: doc.id as number | string, tenantID: tenantOf(options, doc) })
      ctx.organisationName = str(doc.name) || ctx.organisationName
      await dispatchNotifications(req, planOrganisationEmails(doc, previous, ctx), tenantOf(options, doc))
    })

    return doc
  }
