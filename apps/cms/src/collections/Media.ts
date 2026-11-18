import type { CollectionConfig } from 'payload'

import { createFolderField, createTagField } from 'payload'

export const Media: CollectionConfig = {
  slug: 'media',
  access: {
    read: () => true,
  },
  fields: [
    {
      name: 'alt',
      type: 'text',
      required: true,
    },
    createFolderField({ relationTo: 'folders' }),
    createTagField({ relationTo: 'tags' }),
    // mission-control: WordPress attachment ID, for the importer.
    { name: 'legacyId', type: 'number', index: true },
  ],
  // mission-control: images only (documents have their own collection); variants come from
  // the sharp transformer in src/media.ts.
  upload: { mimeTypes: ['image/*'] },
}
