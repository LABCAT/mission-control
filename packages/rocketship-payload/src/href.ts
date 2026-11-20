const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

// Whitespace and control characters are ignored inside a URL scheme by browsers. Strip them
// before deciding what the value is, so `java\tscript:` cannot slip through.
const ignoredInScheme = (char: string): boolean => {
  const code = char.charCodeAt(0)
  return code <= 0x20 || (code >= 0x7f && code <= 0x9f) || char.trim() === ''
}

/**
 * Return the trimmed href when it is a safe destination, otherwise null.
 *
 * Allowed: relative paths starting with `/` (but not `//`), `#` anchors, `?` queries, and
 * `http:`, `https:`, `mailto:` or `tel:` links. Everything else is refused, so a CMS value can
 * never become a `javascript:` (or `data:`/`vbscript:`) href.
 */
export const safeHref = (value: unknown): string | null => {
  if (typeof value !== 'string') return null

  const trimmed = value.trim()
  if (!trimmed) return null

  const compact = [...trimmed]
    .filter((char) => !ignoredInScheme(char))
    .join('')
    .toLowerCase()
  const slashed = compact.replace(/\\/g, '/')

  // Reject protocol-relative URLs, including the `/\evil.com` spelling browsers normalise.
  if (slashed.startsWith('//')) return null
  if (compact.startsWith('#') || compact.startsWith('?') || compact.startsWith('/')) return trimmed

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1]
  return scheme && ALLOWED_SCHEMES.has(scheme) ? trimmed : null
}
