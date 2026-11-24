import type { EmailBlockOutput, EmailTemplateEvent } from './events'

/**
 * Lexical JSON to email-safe HTML and plain text (PJ-50). Only the nodes the template editor
 * offers are rendered; anything else is dropped, never passed through. Every text and chip value
 * is HTML-escaped, and a link only keeps an http(s), mailto or tel address.
 */

export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

type LexicalNode = {
  children?: LexicalNode[]
  fields?: { blockType?: string; key?: string; newTab?: boolean; url?: string }
  format?: number | string
  listType?: string
  tag?: string
  text?: string
  type?: string
  url?: string
}

const SAFE_URL = /^(https?:|mailto:|tel:)/i

/** The href for a link, or `null` when the scheme is not one an email may carry. */
export const safeHref = (url: unknown): null | string => {
  if (typeof url !== 'string') return null
  // Browsers ignore whitespace and control characters inside a scheme, so judge the compact form.
  const compact = [...url.trim()].filter((char) => char.charCodeAt(0) > 0x20 && char.charCodeAt(0) !== 0x7f).join('')

  return SAFE_URL.test(compact) ? url.trim() : null
}

export type RenderContext = {
  /** Resolved chip values by variable key. */
  values: Record<string, string>
  /** Resolved block chip output by block key. */
  blocks: Record<string, EmailBlockOutput>
}

type Output = { html: string; text: string }

const BOLD = 1
const ITALIC = 2
const STRIKE = 4
const UNDERLINE = 8
const CODE = 16

const styleText = (html: string, format: number): string => {
  let out = html
  if (format & CODE) out = `<code>${out}</code>`
  if (format & BOLD) out = `<strong>${out}</strong>`
  if (format & ITALIC) out = `<em>${out}</em>`
  if (format & UNDERLINE) out = `<u>${out}</u>`
  if (format & STRIKE) out = `<s>${out}</s>`

  return out
}

const renderChildren = (nodes: LexicalNode[] | undefined, ctx: RenderContext): Output => {
  const parts = (nodes ?? []).map((node) => renderNode(node, ctx))

  return { html: parts.map((part) => part.html).join(''), text: parts.map((part) => part.text).join('') }
}

const renderNode = (node: LexicalNode, ctx: RenderContext): Output => {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? ''
      return { html: styleText(escapeHtml(text), typeof node.format === 'number' ? node.format : 0), text }
    }
    case 'linebreak':
      return { html: '<br>', text: '\n' }
    case 'inlineBlock': {
      if (node.fields?.blockType !== 'variable') return { html: '', text: '' }
      const value = ctx.values[node.fields.key ?? ''] ?? ''
      return { html: escapeHtml(value), text: value }
    }
    case 'block': {
      const out = ctx.blocks[node.fields?.key ?? '']
      return out ? { html: out.html, text: out.text } : { html: '', text: '' }
    }
    case 'link':
    case 'autolink': {
      const inner = renderChildren(node.children, ctx)
      const href = safeHref(node.fields?.url ?? node.url)
      if (!href) return inner
      return {
        html: `<a href="${escapeHtml(href)}" style="color:inherit">${inner.html}</a>`,
        text: inner.text === href ? href : `${inner.text} (${href})`,
      }
    }
    case 'paragraph': {
      const inner = renderChildren(node.children, ctx)
      return { html: `<p style="margin:0 0 16px">${inner.html}</p>`, text: `${inner.text}\n\n` }
    }
    case 'heading': {
      const tag = node.tag === 'h1' || node.tag === 'h2' || node.tag === 'h3' ? node.tag : 'h3'
      const inner = renderChildren(node.children, ctx)
      return { html: `<${tag} style="margin:0 0 16px">${inner.html}</${tag}>`, text: `${inner.text}\n\n` }
    }
    case 'quote': {
      const inner = renderChildren(node.children, ctx)
      return {
        html: `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid #cccccc">${inner.html}</blockquote>`,
        text: `> ${inner.text}\n\n`,
      }
    }
    case 'list': {
      const ordered = node.listType === 'number'
      const items = (node.children ?? []).map((item, index) => {
        const inner = renderChildren(item.children, ctx)
        return { html: `<li>${inner.html}</li>`, text: `${ordered ? `${index + 1}.` : '-'} ${inner.text}\n` }
      })
      const tag = ordered ? 'ol' : 'ul'
      return {
        html: `<${tag} style="margin:0 0 16px;padding-left:24px">${items.map((item) => item.html).join('')}</${tag}>`,
        text: `${items.map((item) => item.text).join('')}\n`,
      }
    }
    default:
      return { html: '', text: '' }
  }
}

/** Visit every node of a Lexical document, depth first. */
export const walkNodes = (state: unknown, visit: (node: LexicalNode) => void): void => {
  const walk = (node: LexicalNode | undefined): void => {
    if (!node || typeof node !== 'object') return
    visit(node)
    for (const child of node.children ?? []) walk(child)
  }
  walk((state as { root?: LexicalNode } | null | undefined)?.root)
}

/** Every chip a body uses: variable keys and block keys. */
export const chipsOf = (state: unknown): { blocks: string[]; variables: string[] } => {
  const variables: string[] = []
  const blocks: string[] = []
  walkNodes(state, (node) => {
    if (node.type === 'inlineBlock' && node.fields?.blockType === 'variable' && node.fields.key) {
      variables.push(node.fields.key)
    }
    if (node.type === 'block' && node.fields?.key) blocks.push(node.fields.key)
  })

  return { blocks, variables }
}

/** Render a Lexical document. A malformed or empty document renders as empty output. */
export const renderLexical = (state: unknown, ctx: RenderContext): Output => {
  const root = (state as { root?: LexicalNode } | null | undefined)?.root
  if (!root || !Array.isArray(root.children)) return { html: '', text: '' }
  const out = renderChildren(root.children, ctx)

  return { html: out.html, text: out.text.replace(/\n{3,}/g, '\n\n').trim() }
}

/** Resolve every chip an event declares. A missing or throwing value becomes empty text. */
export const resolveChips = async (
  event: EmailTemplateEvent,
  doc: Record<string, unknown>,
  used: { blocks: string[] },
): Promise<RenderContext> => {
  const values: Record<string, string> = {}
  for (const variable of event.variables) {
    let value: unknown
    try {
      value = variable.resolve(doc)
    } catch {
      value = ''
    }
    values[variable.key] = value === null || value === undefined ? '' : String(value)
  }

  const blocks: Record<string, EmailBlockOutput> = {}
  for (const block of event.blocks ?? []) {
    if (!used.blocks.includes(block.key)) continue
    blocks[block.key] = await block.render(doc)
  }

  return { blocks, values }
}
