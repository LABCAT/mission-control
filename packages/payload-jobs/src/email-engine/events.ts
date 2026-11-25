/**
 * Email events (PJ-50). An event is a named thing the platform emails about. payload-jobs
 * declares each event with the variables a template may use (First name, Job title, ...) and
 * its default text; the site manager edits the text per tenant, never the variables.
 *
 * Wiring an event to the code that triggers it is PJ-51; this file is only the declaration.
 */

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

/**
 * The events payload-jobs ships. PJ-51 adds the rest of the legacy set; the engine does not
 * care how many there are.
 */
export const BUILT_IN_EMAIL_EVENTS: EmailTemplateEvent[] = [
  {
    slug: 'job-submitted',
    defaultBody: [
      ['Hello ', { variable: 'firstName' }, ','],
      ['Thanks for submitting ', { variable: 'jobTitle' }, '. We will review it shortly.'],
    ],
    defaultSubject: 'We received your job: {{jobTitle}}',
    label: 'Job submitted',
    recipient: (doc) => str(doc.employerEmail) || undefined,
    variables: [
      { key: 'firstName', label: 'First name', resolve: (doc) => str(doc.firstName) },
      { key: 'jobTitle', label: 'Job title', resolve: (doc) => str(doc.title) },
    ],
  },
  {
    slug: 'job-approved',
    defaultBody: [
      ['Hello ', { variable: 'firstName' }, ','],
      [{ variable: 'jobTitle' }, ' is now live.'],
    ],
    defaultSubject: 'Your job is live: {{jobTitle}}',
    label: 'Job approved',
    recipient: (doc) => str(doc.employerEmail) || undefined,
    variables: [
      { key: 'firstName', label: 'First name', resolve: (doc) => str(doc.firstName) },
      { key: 'jobTitle', label: 'Job title', resolve: (doc) => str(doc.title) },
    ],
  },
]

export type EmailEventRegistry = ReadonlyMap<string, EmailTemplateEvent>

/** Registry by slug. A host event with a built-in's slug replaces it. */
export const createEmailEventRegistry = (
  hostEvents: readonly EmailTemplateEvent[] = [],
): EmailEventRegistry => {
  const registry = new Map<string, EmailTemplateEvent>()
  for (const event of [...BUILT_IN_EMAIL_EVENTS, ...hostEvents]) registry.set(event.slug, event)

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
