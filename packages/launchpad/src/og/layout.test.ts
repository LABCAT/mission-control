import { describe, expect, it } from 'vitest'

import { ogLayout } from './layout'
import type { OgCard } from './card'

const card: OgCard = {
  accent: '#1b7f4b',
  accentText: '#ffffff',
  eyebrow: 'Vanuatu Wok',
  facts: ['Port Vila', 'Full time'],
  kind: 'job',
  logo: { url: 'https://cms/acme.png' },
  siteName: 'Vanuatu Wok',
  subtitle: 'Acme Hospitality',
  title: 'Head Chef',
}

type Node = ReturnType<typeof ogLayout>

/** Every string the tree draws, in document order. */
const drawn = (node: Node): string[] => {
  const children = node.props.children
  const own = typeof children === 'string' ? [children] : []
  const nested = Array.isArray(children) ? children.flatMap((child) => drawn(child as Node)) : []

  return [...own, ...nested]
}

const images = (node: Node): Node[] => {
  const children = node.props.children
  const here = node.type === 'img' ? [node] : []

  return [...here, ...(Array.isArray(children) ? children.flatMap((child) => images(child as Node)) : [])]
}

describe('share card layout', () => {
  it('draws the card text once each, in reading order @S-255', () => {
    const text = drawn(ogLayout(card))

    expect(text).toEqual(['Vanuatu Wok', 'Head Chef', 'Acme Hospitality', 'Port Vila', 'Full time', 'Vanuatu Wok', 'Job vacancy'])
  })

  it('gives every multi-child node an explicit flex display @S-255', () => {
    const check = (node: Node): void => {
      const children = node.props.children
      if (Array.isArray(children) && children.length > 0) {
        // Satori has no default display: a container without one lays out as a block and the
        // children overlap.
        expect(node.props.style).toMatchObject({ display: 'flex' })
        children.forEach((child) => check(child as Node))
      }
    }

    check(ogLayout(card))
  })

  it('draws the logo image when there is one, and none when there is not @S-255', () => {
    expect(images(ogLayout(card))).toHaveLength(1)
    expect(images(ogLayout({ ...card, logo: undefined }))).toHaveLength(0)
  })

  it('keeps the card at the full width and height @S-255', () => {
    expect(ogLayout(card).props.style).toMatchObject({ height: '100%', width: '100%' })
  })

  it('draws no facts row and no subtitle when the card has none @S-255', () => {
    const text = drawn(ogLayout({ ...card, facts: [], subtitle: undefined }))

    expect(text).toEqual(['Vanuatu Wok', 'Head Chef', 'Vanuatu Wok', 'Job vacancy'])
  })

  it('labels an organisation card and a home card differently @S-255', () => {
    expect(drawn(ogLayout({ ...card, kind: 'organisation' }))).toContain('Organisation')
    expect(drawn(ogLayout({ ...card, kind: 'home' })).at(-1)).toBe('')
  })
})
