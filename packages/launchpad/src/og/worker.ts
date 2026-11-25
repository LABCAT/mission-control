/**
 * The share-image renderer for a Cloudflare Worker (PJ-105): the satori + resvg pipeline fed the
 * font and WASM bytes the Worker build bundles.
 *
 * `?module` gives resvg as an already-compiled `WebAssembly.Module`, which is what workerd
 * allows: it refuses to compile WASM bytes handed to it at runtime (which is why satori's default
 * entry does not work there). `?inline` gives the fonts as data URIs, so nothing is fetched.
 *
 * Import this from a Worker only. A test builds its renderer from `render.ts` and file bytes,
 * because the `?inline`/`?module` suffixes are Vite's, not Node's.
 */
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm?module'

import { ogFonts } from './fonts'
import { createOgRenderer, type OgRenderer } from './render'

let renderer: OgRenderer | null = null

/** One renderer per isolate: Yoga and resvg are set up once, not once per image. */
export const ogRenderer = (): OgRenderer => (renderer ??= createOgRenderer({ fonts: ogFonts(), resvgWasm }))
