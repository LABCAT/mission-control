import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { OG_HEIGHT, OG_WIDTH, type OgCard } from './card'
import { ogFonts } from './fonts'
import { createOgRenderer } from './render'

const resolveAsset = createRequire(import.meta.url).resolve

const card = (overrides: Partial<OgCard> = {}): OgCard => ({
  accent: '#1b7f4b',
  accentText: '#ffffff',
  eyebrow: 'Vanuatu Wok',
  facts: ['Port Vila', 'Full time'],
  kind: 'job',
  siteName: 'Vanuatu Wok',
  subtitle: 'Acme Hospitality',
  title: 'Head Chef',
  ...overrides,
})

const renderer = async () => {
  const wasm = await readFile(resolveAsset('@resvg/resvg-wasm/index_bg.wasm'))

  return createOgRenderer({ fonts: ogFonts(), resvgWasm: wasm })
}

/** PNG width and height, read from the IHDR chunk: the renderer's own word on what it drew. */
const pngSize = (png: Uint8Array): { height: number; width: number } => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)

  return { height: view.getUint32(20), width: view.getUint32(16) }
}

describe('share image render', () => {
  it('renders a job card as a PNG at 1200x630 @S-256', async () => {
    const png = await (await renderer()).png(card())

    // The PNG signature, then IHDR as the first chunk.
    expect(png.slice(0, 8)).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(png.slice(12, 16)).toEqual(new Uint8Array([0x49, 0x48, 0x44, 0x52]))
    expect(pngSize(png)).toEqual({ height: OG_HEIGHT, width: OG_WIDTH })
  })

  it('draws the card as SVG markup @S-256', async () => {
    const svg = await (await renderer()).svg(card())

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('width="1200"')
    expect(svg).toContain('height="630"')
    // Satori converts text to paths, so the words are gone but their shapes are not: an SVG
    // with no paths would be a blank card.
    expect(svg).toContain('<path')
    expect(svg).toContain('#1b7f4b')
  })

  it('renders every page kind, including one with no logo and no facts @S-256', async () => {
    const ready = await renderer()
    const kinds: OgCard[] = [
      card({ kind: 'home', facts: [], subtitle: undefined, title: 'Find a job in Vanuatu' }),
      card({ kind: 'organisation', subtitle: undefined }),
      card({ title: 'X'.repeat(70) }),
    ]

    for (const one of kinds) {
      const png = await ready.png(one)
      expect(pngSize(png)).toEqual({ height: OG_HEIGHT, width: OG_WIDTH })
    }
  })
})
