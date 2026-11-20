import type { Field } from 'payload'

/** The fields of one button/link, shared by the hero, cards, feature boxes and CTA. */
export const linkFields: Field[] = [
  {
    name: 'label',
    type: 'text',
    required: true,
  },
  {
    name: 'href',
    type: 'text',
    required: true,
  },
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
