/**
 * Rasterise a share card (PJ-105) to a PNG: `card` → satori element tree → SVG → resvg → PNG.
 *
 * Runtime notes (both learned the hard way on workerd):
 *
 * - satori's default entry bundles a base64 WASM binary and compiles it at runtime, which
 *   workerd refuses (`Wasm code generation disallowed by embedder`). The `satori/wasm` entry
 *   takes a pre-instantiated Yoga instance instead, and `yoga-wasm-web/asm` is a pure JS build,
 *   so nothing is compiled at runtime.
 * - satori 0.15 wants raw font bytes. A `woff` works; a `woff2` is refused
 *   (`Unsupported OpenType signature wOF2`).
 *
 * Fonts and the resvg module are parameters so the caller decides where the bytes come from
 * (Vite `?inline` in the Worker, `readFile` in a test).
 */
import { Resvg, initWasm as initResvg } from '@resvg/resvg-wasm'
import satori, { init as initSatori } from 'satori/wasm'
import initYoga from 'yoga-wasm-web/asm'

import { OG_HEIGHT, OG_WIDTH, type OgCard } from './card'
import { ogLayout, type OgFont } from './layout'

export type OgRenderer = {
  /** The card as SVG. Exposed for tests and for debugging a layout. */
  svg(card: OgCard): Promise<string>
  png(card: OgCard): Promise<Uint8Array>
}

export type CreateRendererOptions = {
  fonts: OgFont[]
  /** The resvg WASM binary, as a module or its bytes. */
  resvgWasm: BufferSource | WebAssembly.Module
}

// Both inits are process-wide and resvg refuses a second call, so the first renderer's setup is
// kept and every later renderer reuses it. In a Worker that is one renderer; in a test process it
// means the renderers share one WASM setup, which is what the module under test wants.
let resvgReady: Promise<void> | null = null
let satoriReady = false

/**
 * One renderer per Worker isolate. Yoga and resvg are initialised once: both are expensive to
 * set up and safe to share, and the per-request work is the layout and the raster.
 */
export const createOgRenderer = ({ fonts, resvgWasm }: CreateRendererOptions): OgRenderer => {
  const prepare = async (): Promise<void> => {
    if (!satoriReady) {
      initSatori(initYoga())
      satoriReady = true
    }
    resvgReady ??= initResvg(resvgWasm)
    await resvgReady
  }

  /**
   * Satori fetches the logo itself. A logo it cannot load (the CMS moved the file, the fetch is
   * blocked) is dropped from the drawing with a warning rather than failing the image, which is
   * the behaviour we want: the card is still worth sharing without it.
   */
  const svg = async (card: OgCard): Promise<string> => {
    await prepare()

    return satori(ogLayout(card) as never, {
      fonts: fonts as never,
      height: OG_HEIGHT,
      width: OG_WIDTH,
    })
  }

  return {
    png: async (card) => {
      const markup = await svg(card)

      return new Resvg(markup, { fitTo: { mode: 'original' } }).render().asPng()
    },
    svg,
  }
}
