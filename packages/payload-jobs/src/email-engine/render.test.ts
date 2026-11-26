import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { BUILT_IN_EMAIL_EVENTS, defaultBodyState, type EmailTemplateEvent } from './events'
import { renderLayout } from './layout'
import { chipsOf, escapeHtml, renderLexical, safeHref } from './lexical'
import { oneLine, renderEmail } from './render'

const golden = (name: string, actual: string): string => {
  const path = fileURLToPath(new URL(`./__golden__/${name}`, import.meta.url))
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, actual)

  return readFileSync(path, 'utf8')
}

const text = (value: string, format = 0) => ({ type: 'text', format, text: value, version: 1 })
const chip = (key: string) => ({ type: 'inlineBlock', fields: { blockType: 'variable', key }, version: 1 })
const paragraph = (...children: unknown[]) => ({ type: 'paragraph', children, version: 1 })
const doc = (...children: unknown[]) => ({ root: { type: 'root', children, version: 1 } })

const JOB_LIST = {
  key: 'jobList',
  label: 'Job list',
  render: (d: Record<string, unknown>) => {
    const jobs = (d.jobs as string[]) ?? []

    return {
      html: `<ul>${jobs.map((job) => `<li>${escapeHtml(job)}</li>`).join('')}</ul>`,
      text: jobs.map((job) => `- ${job}`).join('\n'),
    }
  },
}

const event: EmailTemplateEvent = {
  blocks: [JOB_LIST],
  defaultBody: [['Hi ', { variable: 'firstName' }]],
  defaultSubject: 'Hello {{firstName}}',
  label: 'Test',
  slug: 'test-event',
  variables: [
    { key: 'firstName', label: 'First name', resolve: (d) => d.firstName as string },
    { key: 'jobTitle', label: 'Job title', resolve: (d) => d.title as string },
  ],
}

describe('renderEmail @S-180', () => {
  it('escapes chip values in html, keeps them raw in text', async () => {
    const out = await renderEmail({
      doc: { firstName: '<img src=x onerror=alert(1)> & "Co"', title: 'T' },
      event,
      template: { body: doc(paragraph(text('Dear '), chip('firstName'))), subject: 'Hi' },
    })

    expect(out.html).toContain('Dear &lt;img src=x onerror=alert(1)&gt; &amp; &quot;Co&quot;')
    expect(out.html).not.toContain('<img src=x')
    expect(out.text).toContain('Dear <img src=x onerror=alert(1)> & "Co"')
  })

  it('escapes literal template text too, so a body cannot inject markup', async () => {
    const out = await renderEmail({
      doc: {},
      event,
      template: { body: doc(paragraph(text('<script>alert(1)</script>'))) },
    })

    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('fills subject chips as plain text and cannot be used to inject headers', async () => {
    const out = await renderEmail({
      doc: { firstName: 'Ann\r\nBcc: victim@example.com', title: 'Cook' },
      event,
      template: { subject: 'Job {{jobTitle}} for {{firstName}}', body: doc(paragraph(text('x'))) },
    })

    expect(out.subject).toBe('Job Cook for Ann Bcc: victim@example.com')
    expect(out.subject).not.toMatch(/[\r\n]/)
    expect(oneLine('a\nb')).toBe('a b')
  })

  it('uses the event default text when the tenant has no template', async () => {
    const out = await renderEmail({ doc: { firstName: 'Mere' }, event })

    expect(out.subject).toBe('Hello Mere')
    expect(out.text).toContain('Hi Mere')
  })

  it('renders formats, headings, lists, links and block chips; drops unknown nodes', async () => {
    const body = doc(
      { type: 'heading', tag: 'h2', children: [text('Title')], version: 1 },
      paragraph(text('bold', 1), text(' and '), text('italic', 2)),
      {
        type: 'list',
        listType: 'bullet',
        children: [
          { type: 'listitem', children: [text('one')], version: 1 },
          { type: 'listitem', children: [text('two')], version: 1 },
        ],
        version: 1,
      },
      paragraph({ type: 'link', fields: { url: 'https://example.com/a?b=1&c=2' }, children: [text('site')], version: 1 }),
      { type: 'block', fields: { blockType: 'emailBlock', key: 'jobList' }, version: 1 },
      { type: 'upload', fields: {}, version: 1 },
    )
    const out = await renderEmail({ doc: { jobs: ['Cook', 'A&B'] }, event, template: { body } })

    expect(out.html).toContain('<h2 style="margin:0 0 16px">Title</h2>')
    expect(out.html).toContain('<strong>bold</strong> and <em>italic</em>')
    expect(out.html).toContain('<li>one</li><li>two</li>')
    expect(out.html).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(out.html).toContain('<li>A&amp;B</li>')
    expect(out.text).toBe(
      ['Title', 'bold and italic', '- one\n- two', 'site (https://example.com/a?b=1&c=2)', '- Cook\n- A&B', ''].join('\n\n').replace(/\n\n$/, '\n'),
    )
  })

  it('drops links whose scheme is not safe, even when disguised', () => {
    for (const bad of ['javascript:alert(1)', ' JaVa\tScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.test']) {
      expect(safeHref(bad)).toBeNull()
    }
    expect(safeHref('mailto:a@example.com')).toBe('mailto:a@example.com')
    const out = renderLexical(
      doc(paragraph({ type: 'link', fields: { url: 'javascript:alert(1)' }, children: [text('click')], version: 1 })),
      { blocks: {}, values: {} },
    )
    expect(out.html).toBe('<p style="margin:0 0 16px">click</p>')
  })

  it('renders a malformed or empty body as nothing rather than throwing', () => {
    for (const bad of [null, undefined, 'x', {}, { root: {} }, { root: { children: 'x' } }]) {
      expect(renderLexical(bad, { blocks: {}, values: {} })).toEqual({ html: '', text: '' })
    }
  })

  it('a throwing variable resolver renders empty instead of failing the send', async () => {
    const broken: EmailTemplateEvent = {
      ...event,
      variables: [{ key: 'firstName', label: 'First name', resolve: () => { throw new Error('boom') } }],
    }
    const out = await renderEmail({ doc: {}, event: broken })
    expect(out.subject).toBe('Hello')
  })

  it('lists the chips a body uses', () => {
    expect(
      chipsOf(doc(paragraph(chip('a'), chip('b')), { type: 'block', fields: { key: 'jobList' }, version: 1 })),
    ).toEqual({ blocks: ['jobList'], variables: ['a', 'b'] })
  })

  it('every built-in event renders with its own defaults', async () => {
    for (const builtIn of BUILT_IN_EMAIL_EVENTS) {
      const out = await renderEmail({ doc: { firstName: 'Ann', organisationName: 'Ann', title: 'Cook' }, event: builtIn })
      expect(out.subject).not.toContain('{{')
      expect(out.html).toContain('Ann')
      expect(defaultBodyState(builtIn.defaultBody)).toBeTruthy()
    }
  })
})

describe('email layout golden file @S-180', () => {
  const body = '<p style="margin:0 0 16px">Hello <strong>Mere</strong></p>'

  it('matches the branded layout', () => {
    const html = renderLayout({
      bodyHtml: body,
      branding: {
        backgroundColour: '#eeeeee',
        brandColour: '#0a6e3f',
        footerHtml: '<p style="margin:0">Vanuatu Wok &middot; Port Vila</p>',
        logoUrl: 'https://cdn.example.test/logo.png',
        siteName: 'Wok & Co',
      },
    })
    expect(html).toBe(golden('layout-branded.html', html))
    expect(html).toContain('alt="Wok &amp; Co"')
    expect(html).toContain('@media only screen and (max-width:620px)')
  })

  it('falls back to the default colours and the site name without a logo', () => {
    const html = renderLayout({
      bodyHtml: body,
      branding: { brandColour: 'red;background:url(x)', logoUrl: 'http://insecure.test/l.png', siteName: 'Wok' },
    })
    expect(html).toBe(golden('layout-default.html', html))
    expect(html).not.toContain('url(x)')
    expect(html).not.toContain('insecure.test')
  })
})
