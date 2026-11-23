import { decodeLegacyEntities } from './legacy-text'

/**
 * Legacy job descriptions are WordPress HTML (TinyMCE output, pasted Word markup, and plain text
 * that `wpautop` turned into paragraphs at display time). They are converted once, here, into
 * Lexical JSON with the allowlist the posting form uses: paragraphs, headings, bold, italic,
 * bulleted and numbered lists, line breaks and links. Everything else is unwrapped to its text
 * or, for scripts, styles, frames and embeds, removed with its content. Nothing is ever copied
 * through as markup, so hostile input cannot survive the conversion.
 */

/** Heading tags the editor offers. `h1` is the page title, so legacy `h1` becomes `h2`. */
export const ALLOWED_HEADING_TAGS = ['h2', 'h3', 'h4'] as const
/** Link protocols a description may use. */
export const ALLOWED_LINK_PROTOCOLS = ['http', 'https', 'mailto', 'tel'] as const

const FORMAT_BOLD = 1
const FORMAT_ITALIC = 2

/** Elements removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'noscript',
  'template', 'svg', 'math', 'head', 'title', 'textarea', 'select', 'option', 'button',
])
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'area', 'base', 'col', 'source', 'track'])
/** Elements that start a new block when unwrapped. */
const BLOCKISH = new Set([
  'div', 'section', 'article', 'aside', 'header', 'footer', 'main', 'nav', 'blockquote', 'pre', 'address',
  'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'dl', 'dt', 'dd', 'form',
  'fieldset', 'center', 'hr', 'body', 'html',
])
const MAX_DEPTH = 48

type ElementNode = { attrs: Record<string, string>; children: Node[]; tag: string }
type Node = ElementNode | string

const attributesOf = (source: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    if (!(name in attrs)) attrs[name] = decodeLegacyEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/** A forgiving, linear-time tokenizer and tree builder. Never throws. */
const parse = (html: string): Node[] => {
  const root: ElementNode = { attrs: {}, children: [], tag: '#root' }
  const stack: ElementNode[] = [root]
  const top = () => stack[stack.length - 1]!
  const text = (value: string) => {
    if (value) top().children.push(value)
  }
  let i = 0

  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      text(html.slice(i))
      break
    }
    if (lt > i) text(html.slice(i, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    const next = html[lt + 1] ?? ''
    if (!/[a-zA-Z/!?]/.test(next)) {
      text('<')
      i = lt + 1
      continue
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt)
      i = end === -1 ? html.length : end + 1
      continue
    }

    // Find the end of the tag, honouring quotes so `>` inside an attribute does not end it.
    let j = lt + 1
    let quote = ''
    while (j < html.length) {
      const c = html[j]!
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === '"' || c === "'") quote = c
      else if (c === '>') break
      j++
    }
    if (j >= html.length) {
      i = html.length // an unterminated tag at the end is dropped
      break
    }
    const inner = html.slice(lt + 1, j)
    i = j + 1

    const closing = inner.startsWith('/')
    const nameMatch = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner)
    if (!nameMatch) continue
    const tag = nameMatch[1]!.toLowerCase()

    if (closing) {
      const index = stack.map((node) => node.tag).lastIndexOf(tag)
      if (index > 0) stack.length = index
      continue
    }

    if (DROP_WITH_CONTENT.has(tag)) {
      if (!inner.endsWith('/')) {
        const close = new RegExp(`</${tag}\\s*>`, 'i')
        const rest = html.slice(i)
        const found = close.exec(rest)
        i = found ? i + found.index + found[0].length : html.length
      }
      continue
    }

    const node: ElementNode = { attrs: attributesOf(inner.slice(nameMatch[0].length)), children: [], tag }
    // `<p>` and `<li>` close an open sibling of their own kind, as browsers do.
    if ((tag === 'p' || tag === 'li') && top().tag === tag) stack.pop()
    top().children.push(node)
    if (!VOID.has(tag) && !inner.endsWith('/') && stack.length < MAX_DEPTH) stack.push(node)
  }

  return root.children
}

// ---------------------------------------------------------------------------------------------
// Lexical nodes
// ---------------------------------------------------------------------------------------------

export type LexicalNode = { [key: string]: unknown; type: string }
export type LexicalState = {
  root: {
    children: LexicalNode[]
    direction: 'ltr'
    format: ''
    indent: 0
    type: 'root'
    version: 1
  }
}

const block = (type: string, children: LexicalNode[], extra: Record<string, unknown> = {}): LexicalNode => ({
  children,
  direction: 'ltr',
  format: '',
  indent: 0,
  type,
  version: 1,
  ...extra,
})

const textNode = (value: string, format: number): LexicalNode => ({
  detail: 0, format, mode: 'normal', style: '', text: value, type: 'text', version: 1,
})

// Control characters, whitespace and zero-width characters (`java\tscript:` still runs in browsers).
const HIDDEN_CHARS = new RegExp(String.raw`[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]`, 'g')

/** A link target when its protocol is on the allowlist, else `null`. Obfuscation is undone first. */
export const safeLinkUrl = (value: null | string | undefined): null | string => {
  const cleaned = decodeLegacyEntities(String(value ?? ''))
    .replaceAll(HIDDEN_CHARS, '')
  if (!cleaned || cleaned.length > 2000) return null
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned)
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase()
    if (!(ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(protocol)) return null
    if ((protocol === 'http' || protocol === 'https') && !/^https?:\/\/[^/?#]+/i.test(cleaned)) return null
    return cleaned
  }
  // A bare web address typed without its scheme.
  return /^www\.[^/\s]+\.[^/\s]+/i.test(cleaned) ? `https://${cleaned}` : null
}

type Inline = { format: number; text: string } | { children: Inline[]; url: string } | { break: true }

const collapse = (value: string): string => decodeLegacyEntities(value).replaceAll(/[\s ]+/g, ' ')

/** Collect the inline content of nodes (text, bold, italic, links, breaks). Block children flatten. */
const inlineOf = (nodes: Node[], format: number, inLink: boolean, newlines = false): Inline[] => {
  const out: Inline[] = []
  for (const node of nodes) {
    if (typeof node === 'string') {
      if (newlines && node.includes('\n')) {
        // Raw text between block tags: a newline is a line break, as `wpautop` renders it.
        node.replaceAll('\r', '').split('\n').forEach((line, index) => {
          if (index > 0) out.push({ break: true })
          const value = collapse(line)
          if (value.trim()) out.push({ format, text: value })
        })
        continue
      }
      const value = collapse(node)
      if (value) out.push({ format, text: value })
      continue
    }
    switch (node.tag) {
      case 'br':
        out.push({ break: true })
        break
      case 'img':
      case 'hr':
        break
      case 'strong':
      case 'b':
        out.push(...inlineOf(node.children, format | FORMAT_BOLD, inLink, newlines))
        break
      case 'em':
      case 'i':
        out.push(...inlineOf(node.children, format | FORMAT_ITALIC, inLink, newlines))
        break
      case 'a': {
        const url = inLink ? null : safeLinkUrl(node.attrs.href)
        const children = inlineOf(node.children, format, true, newlines)
        if (url) out.push({ children, url })
        else out.push(...children)
        break
      }
      default:
        out.push(...inlineOf(node.children, format, inLink, newlines))
    }
  }
  return out
}

const trimInline = (items: Inline[]): Inline[] => {
  const list = [...items]
  const isSpace = (item: Inline | undefined) => !!item && 'text' in item && item.text.trim() === ''
  while (list.length > 0 && (isSpace(list[0]) || (list[0] && 'break' in list[0]))) list.shift()
  while (list.length > 0 && (isSpace(list.at(-1)) || (list.at(-1) && 'break' in list.at(-1)!))) list.pop()
  const first = list[0]
  if (first && 'text' in first) list[0] = { ...first, text: first.text.trimStart() }
  const last = list.at(-1)
  if (last && 'text' in last) list[list.length - 1] = { ...last, text: last.text.trimEnd() }
  return list
}

const toLexicalInline = (items: Inline[]): LexicalNode[] =>
  items.flatMap((item): LexicalNode[] => {
    if ('break' in item) return [{ type: 'linebreak', version: 1 }]
    if ('text' in item) return item.text ? [textNode(item.text, item.format)] : []
    const children = toLexicalInline(trimInline(item.children))
    if (children.length === 0) return []
    return [
      block('link', children, { fields: { linkType: 'custom', newTab: false, url: item.url }, version: 3 }),
    ]
  })

const hasContent = (items: Inline[]): boolean =>
  items.some((item) => ('text' in item ? item.text.trim() !== '' : 'children' in item ? hasContent(item.children) : false))

const paragraphOf = (items: Inline[]): LexicalNode[] => {
  const trimmed = trimInline(items)
  if (!hasContent(trimmed)) return []
  return [block('paragraph', toLexicalInline(trimmed), { textFormat: 0, textStyle: '' })]
}

/** Plain-text runs (no markup in the block) follow `wpautop`: blank line = paragraph, newline = break. */
const wpautop = (value: string): Inline[][] =>
  decodeLegacyEntities(value)
    .replaceAll('\r\n', '\n')
    .split(/\n\s*\n/)
    .map((part) => {
      const items: Inline[] = []
      part.trim().split('\n').forEach((line, index) => {
        if (index > 0) items.push({ break: true })
        const clean = line.replaceAll(/[\s ]+/g, ' ').trim()
        if (clean) items.push({ format: 0, text: clean })
      })
      return items
    })

const listOf = (node: ElementNode, depth: number): LexicalNode[] => {
  const ordered = node.tag === 'ol'
  const items: LexicalNode[] = []
  let value = 1
  const addItem = (children: Node[]) => {
    const nested = children.filter((c): c is ElementNode => typeof c !== 'string' && (c.tag === 'ul' || c.tag === 'ol'))
    const rest = children.filter((c) => typeof c === 'string' || (c.tag !== 'ul' && c.tag !== 'ol'))
    const inline = trimInline(inlineOf(rest, 0, false))
    if (hasContent(inline)) items.push(block('listitem', toLexicalInline(inline), { value: value++ }))
    if (depth < 6) {
      for (const sub of nested) {
        const list = listOf(sub, depth + 1)
        if (list.length > 0) items.push(block('listitem', list, { value: value++ }))
      }
    }
  }
  for (const child of node.children) {
    if (typeof child === 'string') continue
    if (child.tag === 'li') addItem(child.children)
    else if (child.tag === 'ul' || child.tag === 'ol') {
      if (depth < 6) {
        const list = listOf(child, depth + 1)
        if (list.length > 0) items.push(block('listitem', list, { value: value++ }))
      }
    }
  }
  if (items.length === 0) return []
  return [block('list', items, { listType: ordered ? 'number' : 'bullet', start: 1, tag: ordered ? 'ol' : 'ul' })]
}

const headingTag = (tag: string): (typeof ALLOWED_HEADING_TAGS)[number] => {
  const level = Number(tag.slice(1))
  return level <= 2 ? 'h2' : level === 3 ? 'h3' : 'h4'
}

/** Convert a run of sibling nodes into block nodes. */
const blocksOf = (nodes: Node[], depth: number): LexicalNode[] => {
  const out: LexicalNode[] = []
  let pending: Node[] = []
  const flush = () => {
    if (pending.length === 0) return
    const hasMarkup = pending.some((node) => typeof node !== 'string')
    if (hasMarkup) {
      out.push(...paragraphOf(inlineOf(pending, 0, false, true)))
    } else {
      for (const items of wpautop(pending.join(''))) out.push(...paragraphOf(items))
    }
    pending = []
  }

  for (const node of nodes) {
    if (typeof node === 'string') {
      pending.push(node)
      continue
    }
    const { tag } = node
    if (/^h[1-6]$/.test(tag)) {
      flush()
      const items = trimInline(inlineOf(node.children, 0, false))
      if (hasContent(items)) out.push(block('heading', toLexicalInline(items), { tag: headingTag(tag) }))
    } else if (tag === 'ul' || tag === 'ol') {
      flush()
      out.push(...listOf(node, 0))
    } else if (tag === 'p') {
      flush()
      out.push(...blocksOfInlineContainer(node, depth))
    } else if (BLOCKISH.has(tag) || tag === 'li' || tag === 'dd' || tag === 'dt') {
      flush()
      out.push(...(depth < MAX_DEPTH ? blocksOf(node.children, depth + 1) : paragraphOf(inlineOf(node.children, 0, false))))
    } else {
      // Inline elements (strong, em, a, span, font, br, ...) and unknown tags stay in the run.
      pending.push(node)
    }
  }
  flush()
  return out
}

/** A `<p>`: its inline content is one paragraph, but a list or heading inside it is kept as a block. */
const blocksOfInlineContainer = (node: ElementNode, depth: number): LexicalNode[] =>
  node.children.some((c) => typeof c !== 'string' && (/^h[1-6]$/.test(c.tag) || c.tag === 'ul' || c.tag === 'ol'))
    ? blocksOf(node.children, depth + 1)
    : paragraphOf(inlineOf(node.children, 0, false))

/** Convert legacy description HTML (or plain text) to a Lexical editor state. `null` when empty. */
export const htmlToLexical = (html: null | string | undefined): LexicalState | null => {
  const source = String(html ?? '')
  if (!source.trim()) return null
  const children = blocksOf(parse(source), 0)
  if (children.length === 0) return null
  return { root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } }
}

/** The visible text of legacy HTML for a plain textarea: tags removed, line breaks kept. */
export const htmlToPlainText = (html: null | string | undefined): string => {
  const state = htmlToLexical(html)
  if (!state) return ''
  const textOf = (node: LexicalNode): string => {
    if (node.type === 'text') return String(node.text ?? '')
    if (node.type === 'linebreak') return '\n'
    const children = ((node.children as LexicalNode[] | undefined) ?? []).map(textOf)
    return node.type === 'list' ? children.join('\n') : children.join('')
  }
  return state.root.children.map(textOf).join('\n\n').trim()
}
