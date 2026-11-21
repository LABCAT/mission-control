import { describe, expect, it } from 'vitest'

import { htmlToLexical, htmlToPlainText, safeLinkUrl, type LexicalNode } from './html-to-lexical'

const kinds = (node: LexicalNode): string[] => [
  node.type,
  ...(((node.children as LexicalNode[] | undefined) ?? []).flatMap(kinds)),
]
const root = (html: string) => htmlToLexical(html)!.root.children
const json = (html: string) => JSON.stringify(htmlToLexical(html))

describe('legacy HTML to Lexical @S-155', () => {
  it('converts paragraphs, bold, italic, headings, lists and links', () => {
    const children = root(
      '<h1>Role</h1><p>Hello <strong>bold</strong> <em>it</em> <a href="https://example.com/a?b=1&amp;c=2">link</a></p>' +
        '<ol><li>One</li><li>Two</li></ol><ul><li>A<ul><li>Nested</li></ul></li></ul>',
    )
    expect(children.map((c) => c.type)).toEqual(['heading', 'paragraph', 'list', 'list'])
    expect(children[0]).toMatchObject({ tag: 'h2' })
    expect(children[2]).toMatchObject({ listType: 'number', tag: 'ol' })
    const paragraph = children[1]!.children as LexicalNode[]
    expect(paragraph.find((n) => n.text === 'bold')).toMatchObject({ format: 1 })
    expect(paragraph.find((n) => n.text === 'it')).toMatchObject({ format: 2 })
    expect(paragraph.find((n) => n.type === 'link')).toMatchObject({
      fields: { linkType: 'custom', url: 'https://example.com/a?b=1&c=2' },
    })
    expect(kinds(children[3]!)).toContain('listitem')
  })

  it('clamps heading levels to h2-h4', () => {
    expect(root('<h2>a</h2><h3>b</h3><h5>c</h5>').map((c) => c.tag)).toEqual(['h2', 'h3', 'h4'])
  })

  it('treats plain text like wpautop: blank line = paragraph, newline = break', () => {
    const children = root('First line\nsecond line\n\nNew paragraph')
    expect(children).toHaveLength(2)
    expect(kinds(children[0]!)).toContain('linebreak')
  })

  it('removes scripts, styles, frames, event handlers and images', () => {
    const out = json(
      '<p>Hi<script>alert(1)</script><style>p{}</style><iframe src="//evil"></iframe></p><img src=x onerror=alert(3)><p onclick="x()">Ok</p>',
    )
    expect(out).not.toMatch(/alert|onerror|onclick|iframe|script|<style|p\{|evil/i)
    expect(out).toContain('Hi')
    expect(out).toContain('Ok')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' java\tscript:alert(1)',
    '&#106;avascript:alert(1)',
    'jav&#x09;ascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '/relative/path',
    '#fragment',
    'http://',
  ])('drops the link target %s but keeps the text', (href) => {
    const out = json(`<p><a href="${href}">label</a></p>`)
    expect(out).not.toContain('"link"')
    expect(out).toContain('label')
  })

  it('keeps http, https, mailto and tel links, and adds https to a bare www address', () => {
    expect(safeLinkUrl('http://a.example')).toBe('http://a.example')
    expect(safeLinkUrl('mailto:jobs@example.com')).toBe('mailto:jobs@example.com')
    expect(safeLinkUrl('tel:+678555010')).toBe('tel:+678555010')
    expect(safeLinkUrl('www.example.com/x')).toBe('https://www.example.com/x')
  })

  it('survives broken markup, unclosed tags and deep nesting without throwing', () => {
    expect(() => htmlToLexical('<p>one<p>two<b>bold<i>both</p><li>stray</ul></div><')).not.toThrow()
    const deep = '<div>'.repeat(20000) + 'deep text' + '</div>'.repeat(20000)
    expect(JSON.stringify(htmlToLexical(deep))).toContain('deep text')
    expect(htmlToLexical('<a href="x" <b>>text')).not.toBeNull()
  })

  it('does not nest links and returns null for empty input', () => {
    const out = json('<p><a href="https://a.test">x <a href="https://b.test">y</a></a></p>')
    expect(out.match(/"type":"link"/g)).toHaveLength(1)
    expect(htmlToLexical('')).toBeNull()
    expect(htmlToLexical('<p>  </p><script>x</script>')).toBeNull()
    expect(htmlToLexical(null)).toBeNull()
  })

  it('gives plain text for the how-to-apply textarea', () => {
    expect(htmlToPlainText('Email <b>us</b> &amp; call\r\n\r\nSecond <script>x</script>')).toBe('Email us & call\n\nSecond')
  })
})
