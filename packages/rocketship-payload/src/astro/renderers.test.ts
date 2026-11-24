import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import Banner from './banner.astro'
import CardGrid from './card-grid.astro'
import Cta from './cta.astro'
import FeatureBoxes from './feature-boxes.astro'
import Form from './form.astro'
import Hero from './hero.astro'
import Map from './map.astro'

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

describe('form renderer @S-320', () => {
  const form = {
    fields: [
      { blockType: 'text', label: 'Your name', name: 'name', required: true },
      { blockType: 'email', label: 'Email', name: 'email', required: true },
      { blockType: 'textarea', label: 'Message', name: 'message', required: true },
    ],
    id: 7,
    submitButtonLabel: 'Send message',
    title: 'Contact',
  }

  const renderForm = (block: object) =>
    container.renderToString(Form, { props: { action: '/api/forms', block } })

  it('draws a plain HTML form that posts to the endpoint the site supplies', async () => {
    const html = await renderForm({ blockType: 'form', form })

    expect(html).toContain('<form')
    expect(html).toContain('action="/api/forms"')
    expect(html).toContain('method="POST"')
    expect(html).toContain('name="name"')
    expect(html).toContain('name="email"')
    expect(html).toContain('name="message"')
    expect(html).toContain('Send message')
    // The form id travels with the post; the endpoint refuses a form it cannot find.
    expect(html).toContain('value="7"')
  })

  it('ships the honeypot and the required markers', async () => {
    const html = await renderForm({ blockType: 'form', form })

    expect(html).toContain('name="rp-website"')
    expect(html).toContain('required')
  })

  it('renders nothing but the heading when the form was not populated', async () => {
    const html = await renderForm({ blockType: 'form', form: 7, heading: 'Contact us' })

    expect(html).toContain('Contact us')
    expect(html).not.toContain('<form')
  })
})

describe('map renderer @S-321', () => {
  it('embeds the map in a lazy iframe, so it loads when a visitor scrolls to it', async () => {
    const html = await render(Map, {
      blockType: 'map',
      latitude: -17.7495,
      longitude: 168.3149,
      title: 'Our office',
    })

    expect(html).toContain('<iframe')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain('openstreetmap.org/export/embed.html')
    expect(html).toContain('title="Our office"')
  })

  it('draws nothing at all without a point or an address, not even the heading', async () => {
    const html = await render(Map, { blockType: 'map', heading: 'Find us' })

    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('Find us')
  })
})
