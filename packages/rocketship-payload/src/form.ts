import type { FormData, FormFieldData, FormFieldOption } from './types'

/** The form-builder field kinds this renderer draws. Others are skipped, never guessed at. */
export const RENDERED_FIELD_KINDS = [
  'checkbox',
  'country',
  'date',
  'email',
  'message',
  'number',
  'radio',
  'select',
  'state',
  'text',
  'textarea',
] as const

export type RenderedFieldKind = (typeof RENDERED_FIELD_KINDS)[number]

/** The input type a text-like field becomes. */
const INPUT_TYPES: Record<string, string> = {
  country: 'text',
  date: 'date',
  email: 'email',
  number: 'number',
  state: 'text',
  text: 'text',
}

export type RenderedFormField = {
  /** A short id, unique within the form. */
  id: string
  kind: RenderedFieldKind
  /** The value used as the submitted field name. */
  name: string
  /** The label text; empty for a message block, which has no control. */
  label: string
  /** Column width the editor chose, in the Payload form builder's scale (100 = full). */
  width: number
  required: boolean
  /** The `type` attribute for input-like kinds, `null` for the others. */
  inputType: null | string
  /** The field's own default, if any. */
  defaultValue: null | string
  /** Preformatted help/choice content: message HTML, or select and radio options. */
  options: FormFieldOption[]
  /** The message field's rich text, already converted to HTML by the caller. */
  html: null | string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const optionList = (options: FormFieldData['options']): FormFieldOption[] =>
  (options ?? [])
    .filter((option): option is FormFieldOption => Boolean(option) && typeof option === 'object')
    .map((option) => ({ label: text(option.label), value: text(option.value) }))
    .filter((option) => option.value !== '')

/** The form document behind a relationship, or `null` when it was not populated. */
export const formFrom = (value: FormData | number | null | string | undefined): FormData | null =>
  value && typeof value === 'object' ? value : null

/**
 * Turn a form's fields into what the renderer draws. A field with no name cannot be submitted,
 * so it is dropped; an unknown block type is dropped rather than rendered as a blind input.
 * `richText` converts a message field's Lexical value; pass `lexicalToHtml` from `/richtext`.
 */
export const formFields = (
  form: FormData | null,
  { richText = () => '' }: { richText?: (value: unknown) => string } = {},
): RenderedFormField[] => {
  const fields = form?.fields ?? []
  const seen = new Set<string>()
  const rendered: RenderedFormField[] = []

  for (const field of fields) {
    if (!field || typeof field !== 'object') continue

    const kind = text(field.blockType) as RenderedFieldKind
    if (!RENDERED_FIELD_KINDS.includes(kind)) continue

    const width = typeof field.width === 'number' && field.width > 0 ? field.width : 100

    if (kind === 'message') {
      rendered.push({
        defaultValue: null,
        html: richText(field.message),
        id: `message-${rendered.length}`,
        inputType: null,
        kind,
        label: '',
        name: '',
        options: [],
        required: false,
        width,
      })
      continue
    }

    const name = text(field.name).trim()
    if (!name || seen.has(name)) continue
    seen.add(name)

    rendered.push({
      defaultValue:
        typeof field.defaultValue === 'string' || typeof field.defaultValue === 'boolean'
          ? String(field.defaultValue)
          : null,
      html: null,
      id: name,
      inputType: INPUT_TYPES[kind] ?? null,
      kind,
      label: text(field.label) || name,
      name,
      options: kind === 'select' || kind === 'radio' ? optionList(field.options) : [],
      required: field.required === true,
      width,
    })
  }

  return rendered
}

/**
 * The hidden field that catches bots: a person never sees it, so a filled value means a bot.
 * It is not a form-builder field, so it is never sent through to the submission's values.
 */
export const HONEYPOT_FIELD = 'rp-website'

/** The lowest-width field in a row: a two-column flow when any field is half width. */
export const formIsMultiColumn = (fields: readonly RenderedFormField[]): boolean =>
  fields.some((field) => field.width > 0 && field.width < 100)
