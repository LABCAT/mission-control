import type { Block, CollectionSlug } from 'payload'

import { linksField, type MediaBlockOptions } from './shared'

export const heroBlock = ({ mediaSlug = 'media' }: MediaBlockOptions = {}): Block => ({
  slug: 'hero',
  interfaceName: 'HeroBlock',
  labels: { singular: 'Hero', plural: 'Heroes' },
  fields: [
    {
      name: 'eyebrow',
      type: 'text',
    },
    {
      name: 'heading',
      type: 'text',
      required: true,
    },
    {
      name: 'body',
      type: 'textarea',
    },
    {
      name: 'image',
      type: 'upload',
      relationTo: mediaSlug as CollectionSlug,
    },
    linksField,
  ],
})
