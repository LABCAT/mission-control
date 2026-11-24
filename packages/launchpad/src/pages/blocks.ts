/**
 * How a page's layout is rendered. Most blocks are generic (rocketship-payload) or job blocks
 * that need no data beyond themselves, so `RenderBlocks` draws them from a component map. The
 * latest-jobs block is different: it needs the jobs, which the page loads once.
 *
 * `pageSegments` keeps the editor's order while separating the blocks that need data, so a site
 * app renders one `RenderBlocks` per run of generic blocks and the job block in between.
 */
import type { BlockLike } from '@mission-control/rocketship-payload/types'

/**
 * The slug of the latest-jobs block. It is the default: the block is registered by the host's
 * `config.blocks` like any other, so a site whose block has another slug names it instead.
 */
export const LATEST_JOBS_BLOCK = 'latest-jobs'

/** True for the block whose renderer needs the loaded jobs. */
export const isLatestJobsBlock = (
  block: BlockLike | null | undefined,
  slug: string = LATEST_JOBS_BLOCK,
): boolean => block?.blockType === slug

/** The slug of the organisation directory block (PJ-38), registered by payload-jobs. */
export const ORGANISATION_DIRECTORY_BLOCK = 'organisation-directory'

export type PageSegment =
  | { blocks: BlockLike[]; kind: 'blocks' }
  | { block: BlockLike; kind: 'latest-jobs' }
  | { block: BlockLike; kind: 'organisation-directory' }

/**
 * Split a layout into runs. Empty and malformed entries are dropped, and consecutive generic
 * blocks stay together so one `RenderBlocks` call draws each run.
 */
export const pageSegments = (
  layout: readonly BlockLike[] | null | undefined,
  slug: string = LATEST_JOBS_BLOCK,
): PageSegment[] => {
  const segments: PageSegment[] = []
  let run: BlockLike[] = []

  const flush = (): void => {
    if (run.length > 0) segments.push({ blocks: run, kind: 'blocks' })
    run = []
  }

  for (const block of layout ?? []) {
    if (!block || typeof block !== 'object' || typeof block.blockType !== 'string') continue

    if (isLatestJobsBlock(block, slug)) {
      flush()
      segments.push({ block, kind: 'latest-jobs' })
      continue
    }

    if (block.blockType === ORGANISATION_DIRECTORY_BLOCK) {
      flush()
      segments.push({ block, kind: 'organisation-directory' })
      continue
    }

    run.push(block)
  }

  flush()

  return segments
}
