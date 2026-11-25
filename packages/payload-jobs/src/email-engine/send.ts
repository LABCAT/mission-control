import type { CollectionSlug, GlobalSlug, Payload } from 'payload'

import { tenantIDOf } from '../catalog'
import type { EmailEventRegistry } from './events'
import { createEmailEventRegistry } from './events'
import type { EmailBranding } from './layout'
import { renderLexical } from './lexical'
import { maskEmail } from './log-policy'
import { renderEmail } from './render'
import { EMAIL_LOG_SLUG, type EmailLogStatus } from './log'
import { EMAIL_TEMPLATES_SLUG } from './templates'

/**
 * `sendTemplate(event, doc)`: the one way the platform sends email (PJ-50). In order it
 *
 * 1. finds the tenant's template for the event (or uses the event's default text);
 * 2. honours the tenant's on/off switch for the event;
 * 3. renders the template inside the tenant's layout;
 * 4. applies the non-production redirect (PJ-94), so a preview never emails the public;
 * 5. hands the message to `payload.sendEmail`, i.e. the tenant's configured transport;
 * 6. writes one email-log row: event, template, tenant, linked record, status, time. No text.
 *
 * It never throws because of a failed send: the caller's work (publishing a job, taking an
 * order) must not roll back over an email. The result and the log row say what happened.
 */

export type RedirectConfig = { label?: string; to?: string }

export type EmailEngineContext = {
  /** Test seam; defaults to `payload.sendEmail`. */
  sendEmail?: (message: OutgoingMessage) => Promise<unknown>
  clock?: () => Date
  events: EmailEventRegistry
  logSlug: string
  payload: Payload
  /**
   * The PJ-94 redirect: a config means "redirect everything to `to`" (non-production), nothing
   * means deliver. The Cloudflare adapter has the same option; this one covers every transport,
   * such as a tenant's own SMTP.
   */
  redirect?: () => Promise<RedirectConfig | undefined> | RedirectConfig | undefined
  settingsSlug: string
  templatesSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}

export type OutgoingMessage = {
  from: { address: string; name?: string }
  html: string
  subject: string
  text: string
  to: string
}

export type SendTemplateOptions = {
  /** The record the email is about, kept in the log as a pointer, never as content. */
  linked?: { collection: string; id: number | string }
  /** Overrides the event's own recipient rule. */
  to?: string
  /** The tenant, when the doc does not carry one. */
  tenant?: number | string
}

export type SendTemplateResult = {
  error?: string
  logID?: number | string
  redirected: boolean
  status: EmailLogStatus
}

type TenantDoc = Record<string, unknown> & {
  emailBranding?: { backgroundColour?: null | string; brandColour?: null | string; footer?: unknown; logoUrl?: null | string }
  emailFromAddress?: null | string
  emailFromName?: null | string
  name?: null | string
}

const EMAIL_IN_TEXT = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g

/** A failure reason safe to keep: no addresses, one line, short. */
export const safeReason = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)

  return message.replace(EMAIL_IN_TEXT, (address) => maskEmail(address)).replace(/\s+/g, ' ').slice(0, 200)
}

const brandingOf = (tenant: TenantDoc | null): EmailBranding => {
  const branding = tenant?.emailBranding
  const footer = branding?.footer ? renderLexical(branding.footer, { blocks: {}, values: {} }) : null

  return {
    backgroundColour: branding?.backgroundColour,
    brandColour: branding?.brandColour,
    footerHtml: footer?.html,
    footerText: footer?.text,
    logoUrl: branding?.logoUrl,
    siteName: tenant?.name,
  }
}

const loadTenant = async (ctx: EmailEngineContext, tenantID: null | number | string): Promise<TenantDoc | null> => {
  if (ctx.tenancy === 'multi') {
    if (tenantID === null) return null

    return (await ctx.payload.findByID({
      collection: ctx.tenantsSlug as CollectionSlug,
      depth: 0,
      id: tenantID,
      overrideAccess: true,
    })) as unknown as TenantDoc
  }

  return (await ctx.payload.findGlobal({
    depth: 0,
    overrideAccess: true,
    slug: ctx.settingsSlug as GlobalSlug,
  })) as unknown as TenantDoc
}

export const sendTemplateWith = async (
  ctx: EmailEngineContext,
  eventSlug: string,
  doc: Record<string, unknown>,
  options: SendTemplateOptions = {},
): Promise<SendTemplateResult> => {
  const event = ctx.events.get(eventSlug)
  if (!event) throw new Error(`sendTemplate: unknown email event "${eventSlug}"`)

  const multi = ctx.tenancy === 'multi'
  const docTenant = tenantIDOf(doc.tenant)
  const given = options.tenant ?? null
  if (given !== null && docTenant !== null && String(given) !== String(docTenant)) {
    throw new Error('sendTemplate: the tenant does not match the record the email is about')
  }
  const tenantID = given ?? docTenant
  if (multi && tenantID === null) throw new Error('sendTemplate: no tenant. Pass `tenant` or a record that has one')

  const tenant = await loadTenant(ctx, tenantID)
  const now = (ctx.clock ?? (() => new Date()))()
  const tenantWhere = multi ? [{ tenant: { equals: tenantID } }] : []

  const templates = await ctx.payload.find({
    collection: ctx.templatesSlug as CollectionSlug,
    depth: 0,
    limit: 1,
    overrideAccess: true,
    pagination: false,
    where: { and: [...tenantWhere, { event: { equals: event.slug } }] },
  })
  const template = (templates.docs[0] ?? null) as null | { body?: unknown; enabled?: boolean; id: number | string; subject?: string }
  const recipient = (options.to ?? event.recipient?.(doc) ?? '').trim()

  const log = async (
    status: EmailLogStatus,
    extra: { reason?: string; redirected?: boolean } = {},
  ): Promise<number | string> => {
    const row = (await ctx.payload.create({
      collection: ctx.logSlug as CollectionSlug,
      data: {
        event: event.slug,
        linkedCollection: options.linked?.collection,
        linkedID: options.linked ? String(options.linked.id) : undefined,
        recipient,
        reason: extra.reason,
        redirected: extra.redirected ?? false,
        sentAt: now.toISOString(),
        status,
        template: template?.id,
        ...(multi ? { tenant: tenantID } : {}),
      } as never,
      overrideAccess: true,
    })) as unknown as { id: number | string }

    return row.id
  }

  // The tenant's switch for this event. No template means the event's default, which is on.
  if (template && template.enabled === false) {
    return { logID: await log('skipped', { reason: 'disabled' }), redirected: false, status: 'skipped' }
  }
  if (!recipient) {
    return { logID: await log('skipped', { reason: 'no recipient' }), redirected: false, status: 'skipped' }
  }

  const from = tenant?.emailFromAddress
  if (!from) {
    return { logID: await log('failed', { reason: 'tenant has no sender address' }), redirected: false, status: 'failed', error: 'tenant has no sender address' }
  }

  let message: OutgoingMessage
  try {
    const rendered = await renderEmail({ branding: brandingOf(tenant), doc, event, template })
    message = {
      from: { address: from, ...(tenant?.emailFromName ? { name: tenant.emailFromName } : {}) },
      html: rendered.html,
      subject: rendered.subject,
      text: rendered.text,
      to: recipient,
    }
  } catch (error) {
    const reason = safeReason(error)

    return { error: reason, logID: await log('failed', { reason }), redirected: false, status: 'failed' }
  }

  // PJ-94: outside production nothing reaches the real recipient.
  const redirect = await ctx.redirect?.()
  const redirected = redirect !== undefined
  if (redirect) {
    if (!redirect.to) {
      return { logID: await log('skipped', { reason: 'non-production: no redirect inbox', redirected: true }), redirected: true, status: 'skipped' }
    }
    message = { ...message, subject: `[${redirect.label ?? 'non-production'} → ${recipient}] ${message.subject}`, to: redirect.to }
  }

  try {
    await (ctx.sendEmail ?? ((outgoing) => ctx.payload.sendEmail(outgoing as never)))(message)
  } catch (error) {
    const reason = safeReason(error)

    return { error: reason, logID: await log('failed', { reason, redirected }), redirected, status: 'failed' }
  }

  return { logID: await log('sent', { redirected }), redirected, status: 'sent' }
}

/** What the plugin stores on `config.custom.payloadJobs.email`. */
export type EmailEngineConfig = {
  events: EmailEventRegistry
  logSlug: string
  redirect?: EmailEngineContext['redirect']
  settingsSlug: string
  templatesSlug: string
  tenancy: 'multi' | 'single'
  tenantsSlug: string
}

export const emailEngineConfig = (payload: Payload): EmailEngineConfig => {
  const stored = (payload.config.custom as { payloadJobs?: { email?: EmailEngineConfig } } | undefined)?.payloadJobs?.email
  if (!stored) throw new Error('sendTemplate: payload-jobs email is not enabled on this Payload instance')

  return stored
}

/**
 * Send an email for an event. `payload` is the host's Payload instance: the events, slugs and
 * redirect come from the `payloadJobs({ email })` plugin options.
 *
 *   await sendTemplate(payload, 'job-submitted', job, { linked: { collection: 'jobs', id: job.id } })
 */
export const sendTemplate = (
  payload: Payload,
  eventSlug: string,
  doc: Record<string, unknown>,
  options?: SendTemplateOptions,
): Promise<SendTemplateResult> => sendTemplateWith({ payload, ...emailEngineConfig(payload) }, eventSlug, doc, options)

export const DEFAULT_EMAIL_SLUGS = { logSlug: EMAIL_LOG_SLUG, templatesSlug: EMAIL_TEMPLATES_SLUG }
export { createEmailEventRegistry }
