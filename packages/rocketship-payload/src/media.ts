import type { BlockMedia } from './types'

/**
 * Payload returns an upload as either the populated document or its id. Renderers need the
 * document; anything else (an id, null, a missing value) draws nothing.
 */
export const mediaFrom = (value: BlockMedia | number | null | undefined): BlockMedia | null =>
  value && typeof value === 'object' ? value : null
