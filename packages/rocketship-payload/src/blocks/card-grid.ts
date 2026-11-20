import type { Block, CollectionSlug } from 'payload'

import { linkField, type MediaBlockOptions } from './shared'

export const cardGridBlock = ({ mediaSlug = 'media' }: MediaBlockOptions = {}): Block => ({
  slug: 'card-grid',
  interfaceName: 'CardGridBlock',
  labels: { singular: 'Card grid', plural: 'Card grids' },
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
      name: 'columns',
      type: 'select',
      defaultValue: '3',
      options: [
        { label: 'Two', value: '2' },
        { label: 'Three', value: '3' },
        { label: 'Four', value: '4' },
      ],
    },
    {
      name: 'cards',
      type: 'array',
      minRows: 1,
      required: true,
      fields: [
        {
          name: 'image',
          type: 'upload',
          relationTo: mediaSlug as CollectionSlug,
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
})
