import type { Block } from 'payload'
import { describe, expect, it } from 'vitest'

import {
  bannerBlock,
  cardGridBlock,
  ctaBlock,
  faqBlock,
  featureBoxesBlock,
  headerBannerField,
  heroBlock,
  richTextBlock,
} from './blocks'

const fieldNamed = (block: Block, name: string) =>
  block.fields.find((field) => 'name' in field && field.name === name)

const blockConfigs = [
  heroBlock(),
  featureBoxesBlock,
  richTextBlock,
  cardGridBlock(),
  ctaBlock,
  faqBlock,
  bannerBlock(),
]

describe('block configs', () => {
  it('registers exactly the blocks the renderers ship', () => {
    expect(blockConfigs.map((block) => block.slug).toSorted()).toEqual([
      'banner',
      'card-grid',
      'cta',
      'faq',
      'feature-boxes',
      'hero',
      'rich-text',
    ])
  })

  it('keeps the required data a renderer reads', () => {
    expect(fieldNamed(heroBlock(), 'heading')).toMatchObject({ type: 'text', required: true })
    expect(fieldNamed(richTextBlock, 'content')).toMatchObject({ type: 'richText', required: true })
    expect(fieldNamed(ctaBlock, 'heading')).toMatchObject({ type: 'text', required: true })
    expect(fieldNamed(faqBlock, 'items')).toMatchObject({ type: 'array', required: true })
    expect(fieldNamed(bannerBlock(), 'desktopImage')).toMatchObject({
      type: 'upload',
      required: true,
    })
  })

  it('points image fields at the host media collection', () => {
    const hero = heroBlock({ mediaSlug: 'uploads' })
    const banner = bannerBlock({ mediaSlug: 'uploads' })
    const cards = fieldNamed(cardGridBlock({ mediaSlug: 'uploads' }), 'cards') as {
      fields: { name?: string; relationTo?: string; type?: string }[]
    }

    expect(fieldNamed(hero, 'image')).toMatchObject({ relationTo: 'uploads', type: 'upload' })
    expect(fieldNamed(banner, 'desktopImage')).toMatchObject({
      relationTo: 'uploads',
      type: 'upload',
    })
    expect(fieldNamed(banner, 'mobileImage')).toMatchObject({
      relationTo: 'uploads',
      type: 'upload',
    })
    expect(cards.fields.find((field) => field.name === 'image')).toMatchObject({
      relationTo: 'uploads',
      type: 'upload',
    })
  })

  it('caps the site-settings header banner at one banner', () => {
    const field = headerBannerField()

    expect(field).toMatchObject({ name: 'headerBanner', type: 'blocks', maxRows: 1 })
    expect(field.blocks).toEqual([expect.objectContaining({ slug: 'banner' })])
  })
})
