import type { CollectionSlug, Field } from 'payload'

export const seoFields = (mediaSlug: CollectionSlug = 'media'): Field => ({
  name: 'seo',
  type: 'group',
  admin: {
    description: 'Overrides for the page metadata. Empty fields fall back to the title.',
  },
  fields: [
    {
      name: 'title',
      type: 'text',
      admin: { description: 'Browser tab and search result title.' },
    },
    {
      name: 'description',
      type: 'textarea',
      admin: { description: 'Meta description, ideally 50 to 160 characters.' },
    },
    {
      name: 'image',
      type: 'upload',
      relationTo: mediaSlug,
      admin: { description: 'Open Graph image. Falls back to the site-wide default.' },
    },
    {
      name: 'noIndex',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Ask search engines not to index this page.' },
    },
  ],
})
