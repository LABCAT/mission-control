import type { Block } from 'payload'

import { linkField } from './shared'

export const featureBoxesBlock: Block = {
  slug: 'feature-boxes',
  interfaceName: 'FeatureBoxesBlock',
  labels: { singular: 'Feature boxes', plural: 'Feature boxes' },
  fields: [
    {
      name: 'heading',
      type: 'text',
    },
    {
      name: 'intro',
      type: 'textarea',
    },
    {
      name: 'items',
      type: 'array',
      minRows: 1,
      required: true,
      fields: [
        {
          name: 'icon',
          type: 'text',
          admin: { description: 'A short glyph or emoji shown above the title.' },
        },
        {
          name: 'title',
          type: 'text',
          required: true,
        },
        {
          name: 'body',
          type: 'textarea',
        },
        linkField,
      ],
    },
  ],
}
