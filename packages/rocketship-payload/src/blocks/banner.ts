import type { Block, BlocksField, CollectionSlug } from 'payload'

import { hrefField, type MediaBlockOptions } from './shared'

export const bannerBlock = ({ mediaSlug = 'media' }: MediaBlockOptions = {}): Block => ({
  slug: 'banner',
  interfaceName: 'BannerBlock',
  labels: { singular: 'Banner', plural: 'Banners' },
  fields: [
    {
      name: 'desktopImage',
      type: 'upload',
      relationTo: mediaSlug as CollectionSlug,
      required: true,
    },
    {
      name: 'mobileImage',
      type: 'upload',
      relationTo: mediaSlug as CollectionSlug,
      admin: { description: 'Optional narrower image; the desktop image is used when empty.' },
    },
    {
      name: 'alt',
      type: 'text',
      admin: { description: 'Overrides the image alt text.' },
    },
    {
      ...hrefField({ required: false }),
      admin: { description: 'Optional link target for the whole banner.' },
    },
    {
      name: 'newTab',
      type: 'checkbox',
      defaultValue: false,
    },
    {
      name: 'priority',
      type: 'checkbox',
      defaultValue: false,
      admin: { description: 'Load eagerly, for the header banner above the fold.' },
    },
  ],
})

/**
 * The site-settings field the layout renders on every page. It carries its own banner block, so
 * the settings global does not have to register one first.
 */
export const headerBannerField = ({
  mediaSlug = 'media',
}: MediaBlockOptions = {}): BlocksField => ({
  name: 'headerBanner',
  type: 'blocks',
  label: 'Header banner',
  maxRows: 1,
  blocks: [bannerBlock({ mediaSlug })],
})
