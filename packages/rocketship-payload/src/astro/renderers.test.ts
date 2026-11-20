import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import Banner from './banner.astro'
import CardGrid from './card-grid.astro'
import Cta from './cta.astro'
import FeatureBoxes from './feature-boxes.astro'
import Hero from './hero.astro'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

const unsafe = 'javascript:alert(1)'
const image = { alt: 'Banner', height: 400, url: '/banner.jpg', width: 1200 }

const render = (Component: Parameters<typeof container.renderToString>[0], block: object) =>
  container.renderToString(Component, { props: { block } })

describe('renderer href guard', () => {
  it('renders an unsafe hero link as plain text', async () => {
    const html = await render(Hero, {
      blockType: 'hero',
      heading: 'Welcome',
      links: [{ href: unsafe, label: 'Unsafe' }],
    })

    expect(html).not.toContain('href=')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('Unsafe')
  })

  it('still renders a safe hero link', async () => {
    const html = await render(Hero, {
      blockType: 'hero',
      heading: 'Welcome',
      links: [{ href: '/jobs', label: 'Jobs' }],
    })

    expect(html).toContain('href="/jobs"')
  })

  it('renders an unsafe CTA link as plain text', async () => {
    const html = await render(Cta, {
      blockType: 'cta',
      heading: 'Apply',
      links: [{ href: unsafe, label: 'Unsafe' }],
    })

    expect(html).not.toContain('href=')
    expect(html).toContain('Unsafe')
  })

  it('renders an unsafe feature-box link as plain text', async () => {
    const html = await render(FeatureBoxes, {
      blockType: 'feature-boxes',
      items: [{ link: { href: unsafe, label: 'Unsafe' }, title: 'Feature' }],
    })

    expect(html).not.toContain('href=')
    expect(html).toContain('Unsafe')
  })

  it('renders an unsafe card-grid link as plain text', async () => {
    const html = await render(CardGrid, {
      blockType: 'card-grid',
      cards: [{ link: { href: unsafe, label: 'Unsafe' }, title: 'Card' }],
    })

    expect(html).not.toContain('href=')
    expect(html).toContain('Unsafe')
  })

  it('renders an unsafe banner link as a plain image', async () => {
    const html = await render(Banner, {
      blockType: 'banner',
      desktopImage: image,
      href: unsafe,
    })

    expect(html).not.toContain('<a ')
    expect(html).not.toContain('href=')
    expect(html).toContain('<img')
  })

  it('still renders a safe banner link', async () => {
    const html = await render(Banner, {
      blockType: 'banner',
      desktopImage: image,
      href: '/promo',
    })

    expect(html).toContain('href="/promo"')
  })
})
