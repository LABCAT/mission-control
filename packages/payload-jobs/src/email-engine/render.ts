import { subjectTokens, SUBJECT_TOKEN, defaultBodyState, type EmailTemplateEvent } from './events'
import { renderLayout, type EmailBranding } from './layout'
import { chipsOf, renderLexical, resolveChips } from './lexical'

export type RenderedEmail = { html: string; subject: string; text: string }

/** The editable part of a tenant's template. Missing parts fall back to the event's defaults. */
export type TemplateContent = { body?: unknown; subject?: null | string }

/**
 * A subject is one line of plain text. Chip values are tenant-user data, so line breaks are
 * collapsed: otherwise a name containing CR/LF could add headers to the message.
 */
export const oneLine = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim()

export const renderSubject = (subject: string, values: Record<string, string>): string =>
  oneLine(subject.replace(SUBJECT_TOKEN, (_match, key: string) => values[key] ?? ''))

/**
 * Render the email for an event: the tenant's template (or the event default) with chips filled
 * from `doc`, inside the layout, plus the plain-text part.
 */
export const renderEmail = async ({
  branding,
  doc,
  event,
  template,
}: {
  branding?: EmailBranding
  doc: Record<string, unknown>
  event: EmailTemplateEvent
  template?: null | TemplateContent
}): Promise<RenderedEmail> => {
  const bodyState = template?.body ?? defaultBodyState(event.defaultBody)
  const subjectSource = template?.subject?.trim() ? template.subject : event.defaultSubject

  const used = chipsOf(bodyState)
  const ctx = await resolveChips(event, doc, used)
  const body = renderLexical(bodyState, ctx)
  const subject = renderSubject(subjectSource, ctx.values)

  const footerText = branding?.footerText ? `\n\n--\n${branding.footerText}` : ''

  return {
    html: renderLayout({ bodyHtml: body.html, branding }),
    subject,
    text: `${body.text}${footerText}\n`,
  }
}

export { subjectTokens }
