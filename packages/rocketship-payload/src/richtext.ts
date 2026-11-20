import { convertLexicalToHTML } from '@payloadcms/richtext-lexical/html'
import type { SerializedEditorState } from '@payloadcms/richtext-lexical/lexical'

/**
 * Convert a Payload Lexical field to HTML for the rich-text renderers. A missing or malformed
 * value renders nothing instead of throwing the page away.
 */
export const lexicalToHtml = (data: unknown): string => {
  if (!data || typeof data !== 'object') return ''

  const root = (data as { root?: unknown }).root
  if (!root || typeof root !== 'object' || !Array.isArray((root as { children?: unknown }).children)) {
    return ''
  }

  try {
    return convertLexicalToHTML({ data: data as SerializedEditorState })
  } catch {
    return ''
  }
}
