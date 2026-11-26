/**
 * Email events (PJ-50). An event is a named thing the platform emails about. payload-jobs
 * declares each event with the variables a template may use (First name, Job title, ...) and
 * its default text; the site manager edits the text per tenant, never the variables.
 *
 * Wiring an event to the code that triggers it is PJ-51; this file is only the declaration.
 */

import { NOTIFICATION_EVENTS } from './notification-events'

export type EmailValue = boolean | null | number | string | undefined

/** A value a template can place with a chip, e.g. "First name". */
export type EmailVariable = {
  key: string
  label: string
  /** Reads the value from the record the email is about. Escaped by the renderer. */
  resolve: (doc: Record<string, unknown>) => EmailValue
}

/** Rendered output of a developer-built block chip such as "Job list". */
export type EmailBlockOutput = { html: string; text: string }

/**
 * A developer-built chip for lists and loops (decision 19 Nov). Site managers insert it; no
 * template logic is exposed. `html` must already be escaped: use `escapeHtml` on every value.
 */
export type EmailBlockChip = {
  key: string
  label: string
  render: (doc: Record<string, unknown>) => EmailBlockOutput | Promise<EmailBlockOutput>
}

/** One paragraph of default body text: plain strings and `{ variable }` chips. */
export type DefaultParagraph = (string | { variable: string })[]

export type EmailTemplateEvent = {
  blocks?: EmailBlockChip[]
  /** Default paragraphs, used until the tenant writes its own template. */
  defaultBody: DefaultParagraph[]
  /** Plain text, with `{{key}}` for variables. */
  defaultSubject: string
  label: string
  /** Who the email goes to, when the caller does not name a recipient. */
  recipient?: (doc: Record<string, unknown>) => null | string | undefined
  slug: string
  variables: EmailVariable[]
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The events payload-jobs ships: the job, order and organisation emails (PJ-51). */
export const BUILT_IN_EMAIL_EVENTS: EmailTemplateEvent[] = NOTIFICATION_EVENTS

const applicationVariables: EmailVariable[] = [
  { key: 'applicantName', label: 'Applicant name', resolve: (doc) => str(doc.applicantName) },
  { key: 'applicantEmail', label: 'Applicant email', resolve: (doc) => str(doc.applicantEmail) },
  { key: 'applicantPhone', label: 'Applicant phone', resolve: (doc) => str(doc.applicantPhone) },
  { key: 'message', label: 'Applicant message', resolve: (doc) => str(doc.message) },
  { key: 'jobTitle', label: 'Job title', resolve: (doc) => str(doc.jobTitle) },
  { key: 'organisationName', label: 'Organisation name', resolve: (doc) => str(doc.organisationName) },
]

const applicationLinkVariables: EmailVariable[] = [
  { key: 'cvLink', label: 'CV download link', resolve: (doc) => str(doc.cvLink) },
  { key: 'coverLetterLink', label: 'Cover letter download link', resolve: (doc) => str(doc.coverLetterLink) },
  { key: 'linksExpireAt', label: 'Links expire at', resolve: (doc) => str(doc.linksExpireAt) },
]

/**
 * Job applications (PJ-45). The recipient is chosen on the server and passed as `doc.to`; the
 * engine's per-tenant switch decides whether each one goes. Only the employer's and the admin's
 * emails carry signed file links: the applicant already has their files.
 */
export const APPLICATION_EMAIL_EVENTS: EmailTemplateEvent[] = [
  {
    slug: 'application-received',
    defaultBody: [
      [{ variable: 'applicantName' }, ' applied for ', { variable: 'jobTitle' }, '.'],
      ['Email: ', { variable: 'applicantEmail' }],
      ['Phone: ', { variable: 'applicantPhone' }],
      ['Message: ', { variable: 'message' }],
      ['CV: ', { variable: 'cvLink' }],
      ['Cover letter: ', { variable: 'coverLetterLink' }],
      ['These links work until ', { variable: 'linksExpireAt' }, '.'],
    ],
    defaultSubject: 'New application: {{jobTitle}}',
    label: 'Application received (to the employer)',
    recipient: (doc) => str(doc.to) || undefined,
    variables: [...applicationVariables, ...applicationLinkVariables],
  },
  {
    slug: 'application-copy',
    defaultBody: [
      ['Thanks for applying for ', { variable: 'jobTitle' }, ' at ', { variable: 'organisationName' }, '.'],
      ['Your message: ', { variable: 'message' }],
    ],
    defaultSubject: 'Your application: {{jobTitle}}',
    label: 'Application copy (to the applicant)',
    recipient: (doc) => str(doc.to) || undefined,
    variables: applicationVariables,
  },
  {
    slug: 'application-admin-copy',
    defaultBody: [
      [{ variable: 'applicantName' }, ' applied for ', { variable: 'jobTitle' }, ' at ', { variable: 'organisationName' }, '.'],
      ['Email: ', { variable: 'applicantEmail' }],
      ['CV: ', { variable: 'cvLink' }],
    ],
    defaultSubject: 'Application copy: {{jobTitle}}',
    label: 'Application copy (to the site admin)',
    recipient: (doc) => str(doc.to) || undefined,
    variables: [...applicationVariables, ...applicationLinkVariables],
  },
]

export type EmailEventRegistry = ReadonlyMap<string, EmailTemplateEvent>

/** Registry by slug. A host event with a built-in's slug replaces it. */
export const createEmailEventRegistry = (
  hostEvents: readonly EmailTemplateEvent[] = [],
): EmailEventRegistry => {
  const registry = new Map<string, EmailTemplateEvent>()
  for (const event of [...BUILT_IN_EMAIL_EVENTS, ...APPLICATION_EMAIL_EVENTS, ...hostEvents]) registry.set(event.slug, event)

  return registry
}

/** `{{key}}` tokens in a subject, in order. */
export const SUBJECT_TOKEN = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g

export const subjectTokens = (subject: string): string[] =>
  [...subject.matchAll(SUBJECT_TOKEN)].map((match) => match[1] as string)

/** Lexical JSON for the default paragraphs, with variable chips as inline blocks. */
export const defaultBodyState = (paragraphs: readonly DefaultParagraph[]): Record<string, unknown> => ({
  root: {
    type: 'root',
    children: paragraphs.map((parts) => ({
      type: 'paragraph',
      children: parts.map((part) =>
        typeof part === 'string'
          ? { type: 'text', format: 0, text: part, version: 1 }
          : { type: 'inlineBlock', fields: { blockType: 'variable', key: part.variable }, version: 1 },
      ),
      direction: 'ltr',
      format: '',
      indent: 0,
      version: 1,
    })),
    direction: 'ltr',
    format: '',
    indent: 0,
    version: 1,
  },
})
