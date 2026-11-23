import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import SiteLayout from './SiteLayout.astro'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

describe('SiteLayout', () => {
  it('forwards the nav and footer-nav slots into the page chrome @S-295', async () => {
    const html = await container.renderToString(SiteLayout, {
      props: { path: '/about', title: 'About us | Vanuatu Wok' },
      slots: {
        default: '<p>body</p>',
        'footer-nav': '<nav aria-label="Footer"><a href="/jobs">Jobs</a></nav>',
        nav: '<nav aria-label="Main"><a href="/about">About us</a></nav>',
      },
    })

    expect(html).toContain('aria-label="Main"')
    expect(html).toContain('aria-label="Footer"')
    expect(html).toContain('<link href="/brand/icon-32.png" rel="icon"')
    expect(html).toContain('<p>body</p>')
  })

  it('renders the brand alone when the page has no menus yet @S-290', async () => {
    const html = await container.renderToString(SiteLayout, {
      props: { path: '/', title: 'Vanuatu Wok' },
      slots: { default: '' },
    })

    expect(html).toContain('class="lp-brand"')
    expect(html).not.toContain('aria-label="Main"')
  })
})
