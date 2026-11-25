/**
 * The fonts a share image is drawn with (PJ-105): Inter latin, regular and bold.
 *
 * They are imported twice over. In the Worker, Vite `?inline` turns each file into a data URI
 * that is bundled into the chunk, so the renderer needs no fetch and no binding. In a test the
 * same data URI is decoded back to bytes. satori 0.15 takes `woff`, not `woff2`.
 *
 * The files come from `@fontsource/inter` (SIL OFL 1.1), so the licence travels with the font.
 */
import boldUrl from '@fontsource/inter/files/inter-latin-700-normal.woff?inline'
import regularUrl from '@fontsource/inter/files/inter-latin-400-normal.woff?inline'

import type { OgFont } from './layout'

/** Bytes from a `data:` URI, which is what a Vite `?inline` import returns. */
export const decodeDataUri = (dataUri: string): Uint8Array => {
  const comma = dataUri.indexOf(',')
  if (!dataUri.startsWith('data:') || comma === -1) {
    throw new TypeError('decodeDataUri: expected a data URI')
  }

  const binary = atob(dataUri.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)

  return bytes
}

let cached: OgFont[] | null = null

/** The card's two weights. Built once per isolate: decoding 60 KB of base64 per request adds up. */
export const ogFonts = (): OgFont[] => {
  cached ??= [
    { data: decodeDataUri(regularUrl), name: 'Inter', style: 'normal', weight: 400 },
    { data: decodeDataUri(boldUrl), name: 'Inter', style: 'normal', weight: 700 },
  ]

  return cached
}
