import { describe, expect, it } from 'vitest'

import { lexicalToHtml } from './richtext'

const paragraph = {
  root: {
    children: [
      {
        children: [
          {
            detail: 0,
            format: 0,
            mode: 'normal',
            style: '',
            text: 'Hello Vanuatu',
            type: 'text',
            version: 1,
          },
        ],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
}

describe('lexicalToHtml', () => {
  it('converts a stored Lexical state to HTML', () => {
    expect(lexicalToHtml(paragraph)).toContain('<p>Hello Vanuatu</p>')
  })

  it('renders nothing for a missing or malformed value', () => {
    expect(lexicalToHtml(null)).toBe('')
    expect(lexicalToHtml({})).toBe('')
    expect(lexicalToHtml({ root: { children: 'not-an-array' } })).toBe('')
  })
})
