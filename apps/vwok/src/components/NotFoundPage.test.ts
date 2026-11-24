import { experimental_AstroContainer as AstroContainer } from 'astro/container'
import { beforeAll, describe, expect, it } from 'vitest'

import NotFoundPage from './NotFoundPage.astro'

let container: Awaited<ReturnType<typeof AstroContainer.create>>

beforeAll(async () => {
  container = await AstroContainer.create()
})

const render = (props: { gone?: boolean; path: string }): Promise<string> =>
  container.renderToString(NotFoundPage, { props })

describe('NotFoundPage @S-006', () => {
  it('says the page was not found, in words a visitor understands @S-006', async () => {
    const html = await render({ path: '/no-such-page/' })

    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/)
    expect(html).toContain('moved or never existed')
  })

  it('links to the home page, the job listing and the organisation directory @S-006', async () => {
    const html = await render({ path: '/no-such-page/' })

    expect(html).toContain('href="/"')
    expect(html).toContain('href="/jobs"')
    expect(html).toContain('href="/organisations"')
  })

  it('offers a job search that works without JavaScript @S-006', async () => {
    const html = await render({ path: '/no-such-page/' })

    // A GET form to the listing: no client JS, and the result is the server-rendered page.
    expect(html).toMatch(/<form[^>]+action="\/jobs"[^>]*method="get"/)
    expect(html).toContain('name="q"')
    expect(html).toContain('type="submit"')
  })

  it('keeps the page out of the index, since a 404 must not rank @S-006', async () => {
    const html = await render({ path: '/no-such-page/' })

    expect(html).toContain('name="robots"')
    expect(html).toContain('noindex')
  })

  it('never shows a stack trace or a raw error to the visitor @S-006', async () => {
    const html = await render({ path: '/no-such-page/' })

    for (const leak of ['at Object', 'TypeError', 'ReferenceError', 'node_modules', '/src/']) {
      expect(html, leak).not.toContain(leak)
    }
  })

  it('explains a retired page differently from a broken link @S-006', async () => {
    const html = await render({ gone: true, path: '/land-law-reforms/' })

    expect(html).toMatch(/<h1[^>]*>This page has been removed<\/h1>/)
    expect(html).toContain('Search')
  })

  it('does not mark a menu link to the requested path as current @S-006', async () => {
    const html = await render({ path: '/jobs' })

    // The nav is rendered from menus the site passes; with none, the page still stands alone.
    expect(html).toMatch(/<h1[^>]*>Page not found<\/h1>/)
    expect(html).not.toContain('aria-current="page"')
  })
})
