import type { CollectionSlug, GlobalSlug, Payload } from 'payload'

import type { BlockData } from './types'

export type FindDocumentBlocksOptions = {
  /** The collection that holds the page/document. */
  collection: CollectionSlug
  /** Read the blocks from this field. Defaults to `layout`. */
  field?: string
  /** Return populated uploads and relationships. Defaults to 1. */
  depth?: number
  /** The document's `slug` value. */
  slug: string
}

export type FindGlobalBlocksOptions = {
  /** Read the blocks from this field. Defaults to `layout`. */
  field?: string
  /** Return populated uploads and relationships. Defaults to 1. */
  depth?: number
  /** The global's slug. */
  slug: GlobalSlug
}

export type BlocksResult<TDocument> = {
  blocks: BlockData[]
  document: TDocument | null
}

const blocksFrom = <TDocument>(document: TDocument | null, field: string): BlockData[] => {
  if (!document || typeof document !== 'object') return []

  const value = (document as Record<string, unknown>)[field]
  return Array.isArray(value) ? (value as BlockData[]) : []
}

/**
 * Local API helper for a site rendered in the same process as Payload. The job sites use the
 * REST API with a site key; a site booted inside the CMS can use this instead.
 */
export const findDocumentBlocks = async <TDocument = Record<string, unknown>>(
  payload: Payload,
  { collection, depth = 1, field = 'layout', slug }: FindDocumentBlocksOptions,
): Promise<BlocksResult<TDocument>> => {
  const result = await payload.find({
    collection,
    depth,
    limit: 1,
    where: { slug: { equals: slug } },
  })
  const document = (result.docs[0] ?? null) as TDocument | null

  return { blocks: blocksFrom(document, field), document }
}

/** Read the blocks out of a global (for example the site settings header banner). */
export const findGlobalBlocks = async <TDocument = Record<string, unknown>>(
  payload: Payload,
  { depth = 1, field = 'layout', slug }: FindGlobalBlocksOptions,
): Promise<BlocksResult<TDocument>> => {
  const document = (await payload.findGlobal({ depth, slug })) as TDocument

  return { blocks: blocksFrom(document, field), document }
}
