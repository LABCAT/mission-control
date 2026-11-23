import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import ConsentLine from '../components/ConsentLine.astro'
import SiteFooter from '../components/SiteFooter.astro'
import { consentLine, legalFooterLinks, LEGAL_PAGE_PATHS } from './links'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

describe('legalFooterLinks', () => {
  it('links to both pages at their seeded paths with default labels', () => {
    expect(legalFooterLinks()).toEqual([
      { href: '/privacy', kind: 'privacy', label: 'Privacy policy' },
      { href: '/terms', kind: 'terms', label: 'Terms of use' },
    ])
  })

  it('uses a footer menu item’s own label and URL when the site manager set one', () => {
    const links = legalFooterLinks([
      { label: 'Privacy', url: '/privacy/' },
      { label: 'Terms & conditions', url: 'https://vanuatuwok.vu/terms' },
    ])

    expect(links[0]).toMatchObject({ href: '/privacy/', label: 'Privacy' })
    expect(links[1]).toMatchObject({ href: 'https://vanuatuwok.vu/terms', label: 'Terms & conditions' })
  })

  it('recognises a page relationship as well as a URL', () => {
    const links = legalFooterLinks([{ label: 'Your privacy', page: { slug: 'privacy' } }])

    expect(links[0]).toMatchObject({ href: '/privacy', label: 'Your privacy' })
  })

  it('ignores items that are neither legal page, and falls back to the default label', () => {
    const links = legalFooterLinks([
      { label: 'Jobs', url: '/jobs' },
      { label: '', url: '/privacy' },
    ])

    expect(links.map((link) => link.href)).toEqual(['/privacy', '/terms'])
    expect(links[0]?.label).toBe('Privacy policy')
  })

  it('takes labels in the tenant language', () => {
    const links = legalFooterLinks([], { privacy: 'Politique de confidentialité' })

    expect(links[0]?.label).toBe('Politique de confidentialité')
    expect(links[1]?.label).toBe('Terms of use')
  })
})

describe('consentLine', () => {
  it('words the apply, alert and sign-up lines differently', () => {
    expect(consentLine('apply').text).toContain('CV')
    expect(consentLine('alert').text).toContain('email you matching jobs')
    expect(consentLine('signup').text).toContain('creating an account')
  })

  it('links the policy and the terms, and follows the paths the site sets', () => {
    const line = consentLine('signup', { privacyPath: '/legal/privacy', termsLabel: 'Terms' })

    expect(line.privacy.href).toBe('/legal/privacy')
    expect(line.terms.href).toBe(LEGAL_PAGE_PATHS.terms)
    expect(line.terms.label).toBe('Terms')
  })
})

describe('SiteFooter', () => {
  it('always shows the privacy and terms links, plus the site name', async () => {
    const html = await container.renderToString(SiteFooter, { props: { name: 'Vanuatu Wok' } })

    expect(html).toContain('href="/privacy"')
    expect(html).toContain('Privacy policy')
    expect(html).toContain('href="/terms"')
    expect(html).toContain('Terms of use')
    expect(html).toContain('Vanuatu Wok')
  })

  it('lists the site’s own footer menu items before the legal links', async () => {
    const html = await container.renderToString(SiteFooter, {
      props: {
        items: [
          { label: 'About us', url: '/about' },
          { label: 'Privacy', url: '/privacy' },
        ],
        name: 'Vanuatu Wok',
      },
    })

    expect(html).toContain('href="/about"')
    expect(html).toContain('About us')
    // The menu item's label wins over the default one, and the link is not repeated.
    expect(html).toContain('>Privacy<')
    expect(html).not.toContain('Privacy policy')
    expect(html.match(/href="\/privacy"/g)).toHaveLength(1)
  })
})

describe('ConsentLine', () => {
  it('renders the wording with both links and no client JavaScript', async () => {
    const html = await container.renderToString(ConsentLine, { props: { kind: 'apply' } })

    expect(html).toContain('lp-consent')
    expect(html).toContain('href="/privacy"')
    expect(html).toContain('href="/terms"')
    expect(html).not.toContain('<script')
  })
})
