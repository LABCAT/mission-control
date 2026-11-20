import type { Block, TextField } from 'payload'
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
import { hrefField } from './blocks/shared'

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

  it('rejects unsafe link destinations in the field config', () => {
    const validate = hrefField().validate as unknown as (
      value: unknown,
      options: unknown,
    ) => string | true

    for (const value of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.com',
    ]) {
      expect(validate(value, {})).toEqual(expect.stringContaining('http'))
    }
  })

  it('accepts safe link destinations in the field config', () => {
    const validate = hrefField().validate as unknown as (
      value: unknown,
      options: unknown,
    ) => string | true

    for (const value of [
      '/jobs',
      '#top',
      '?q=vanuatu',
      'https://example.com',
      'mailto:jobs@example.com',
      'tel:+6781234567',
    ]) {
      expect(validate(value, {})).toBe(true)
    }
  })

  it('trims a stored href before validation', () => {
    const hook = hrefField().hooks?.beforeValidate?.[0] as unknown as (args: {
      value: unknown
    }) => unknown

    expect(hook({ value: '  /jobs  ' })).toBe('/jobs')
  })

  it('keeps the banner link optional', () => {
    const field = fieldNamed(bannerBlock(), 'href') as TextField
    const validate = field.validate as unknown as (value: unknown, options: unknown) => string | true

    expect(field).toMatchObject({ required: false, type: 'text' })
    expect(validate('', {})).toBe(true)
  })

  it('caps the site-settings header banner at one banner', () => {
    const field = headerBannerField()

    expect(field).toMatchObject({ name: 'headerBanner', type: 'blocks', maxRows: 1 })
    expect(field.blocks).toEqual([expect.objectContaining({ slug: 'banner' })])
  })
})
