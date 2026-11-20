import type { Field, TextField, TextFieldSingleValidation } from 'payload'

import { safeHref } from '../href'

const HREF_MESSAGE =
  'Use a relative path starting with "/", an anchor (#), a query (?), or an http, https, mailto or tel link.'

/** A link destination field with the same URL policy as the renderers. */
export const hrefField = ({ required = true }: { required?: boolean } = {}): TextField => ({
  name: 'href',
  type: 'text',
  required,
  hooks: {
    beforeValidate: [({ value }) => (typeof value === 'string' ? value.trim() : value)],
  },
  validate: ((value) => {
    if (value === null || value === undefined) return true
    if (typeof value === 'string' && value.trim() === '') return true
    return safeHref(value) ? true : HREF_MESSAGE
  }) satisfies TextFieldSingleValidation,
})

/** The fields of one button/link, shared by the hero, cards, feature boxes and CTA. */
export const linkFields: Field[] = [
  {
    name: 'label',
    type: 'text',
    required: true,
  },
  hrefField(),
  {
    name: 'variant',
    type: 'select',
    defaultValue: 'primary',
    options: [
      { label: 'Primary', value: 'primary' },
      { label: 'Secondary', value: 'secondary' },
    ],
  },
]

/** A single optional link, for card and feature-box items. */
export const linkField: Field = {
  name: 'link',
  type: 'group',
  fields: linkFields,
}

/** The array of links a hero or CTA can show. */
export const linksField: Field = {
  name: 'links',
  type: 'array',
  maxRows: 3,
  fields: linkFields,
}

export type MediaBlockOptions = {
  /** The host's upload collection. Defaults to `media`. */
  mediaSlug?: string
}
