/**
 * The data shapes the renderers accept. They are plain Payload block documents: a renderer
 * never fetches, it only draws what it is given.
 */

export type BlockMedia = {
  alt?: null | string
  height?: null | number
  id?: number | string
  url?: null | string
  width?: null | number
}

export type BlockLink = {
  href: string
  label: string
  variant?: 'primary' | 'secondary' | null
}

export type BlockBase<TBlockType extends string> = {
  blockName?: null | string
  blockType: TBlockType
  id?: number | string
}

export type HeroBlock = BlockBase<'hero'> & {
  body?: null | string
  eyebrow?: null | string
  heading: string
  image?: BlockMedia | number | null
  links?: BlockLink[] | null
}

export type FeatureBox = {
  body?: null | string
  icon?: null | string
  link?: BlockLink | null
  title: string
}

export type FeatureBoxesBlock = BlockBase<'feature-boxes'> & {
  heading?: null | string
  intro?: null | string
  items: FeatureBox[]
}

/** A Payload Lexical editor state, as stored in a `richText` field. */
export type RichTextData = {
  root: {
    children: unknown[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type RichTextBlock = BlockBase<'rich-text'> & {
  content: RichTextData
  heading?: null | string
}

export type CardGridItem = {
  body?: null | string
  image?: BlockMedia | number | null
  link?: BlockLink | null
  title: string
}

export type CardGridBlock = BlockBase<'card-grid'> & {
  cards: CardGridItem[]
  columns?: '2' | '3' | '4' | null
  heading?: null | string
  intro?: null | string
}

export type CtaBlock = BlockBase<'cta'> & {
  body?: null | string
  heading: string
  links?: BlockLink[] | null
}

export type FaqItem = {
  answer: RichTextData
  question: string
}

export type FaqBlock = BlockBase<'faq'> & {
  heading?: null | string
  items: FaqItem[]
}

export type BannerBlock = BlockBase<'banner'> & {
  alt?: null | string
  desktopImage: BlockMedia | number
  href?: null | string
  mobileImage?: BlockMedia | number | null
  newTab?: boolean | null
  /** Load eagerly for a banner above the fold (the site-settings header banner). */
  priority?: boolean | null
}

export type BlockData =
  | BannerBlock
  | CardGridBlock
  | CtaBlock
  | FaqBlock
  | FeatureBoxesBlock
  | HeroBlock
  | RichTextBlock

/** The minimum a value needs to be for the renderer map to look it up. */
export type BlockLike = {
  blockType?: string
  [key: string]: unknown
}
