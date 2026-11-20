import type { AstroComponentFactory } from 'astro/runtime/server/index.js'

import type { BlockData, BlockLike } from './types'

export type BlockComponentMap = Record<string, AstroComponentFactory>

export type ResolvedBlock = {
  block: BlockData
  Component: AstroComponentFactory
}

export type ResolveBlocksOptions = {
  /** Log skipped block types. Callers pass the bundler's dev flag. */
  dev?: boolean
}

/**
 * Map each block to the component the consumer imported. The map is explicit, so a site only
 * bundles the renderers it names; an unknown block is skipped rather than crashing the page.
 */
export const resolveBlocks = (
  blocks: readonly BlockLike[] | null | undefined,
  components: BlockComponentMap,
  { dev = false }: ResolveBlocksOptions = {},
): ResolvedBlock[] => {
  const resolved: ResolvedBlock[] = []

  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue

    const blockType = typeof block.blockType === 'string' ? block.blockType : ''
    const Component = Object.hasOwn(components, blockType) ? components[blockType] : undefined

    if (!Component) {
      if (dev) {
        console.warn(
          `[rocketship-payload] No renderer for block type "${blockType || 'unknown'}"; skipping it.`,
        )
      }
      continue
    }

    resolved.push({ block: block as BlockData, Component })
  }

  return resolved
}
