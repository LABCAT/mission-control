import type { CollectionConfig } from 'payload'

export const Tags: CollectionConfig = {
  slug: 'tags',
  admin: {
    useAsTitle: 'name',
  },
  tags: true,
  // mission-control: drafts let an editor stage a tag before a public site can read it, and
  // give the site-key smoke a published/draft pair to assert against on a real preview (PJ-76).
  versions: { drafts: true },
  fields: [
    {
      name: 'name',
      type: 'text',
      required: true,
    },
  ],
}
