import { createHash } from 'node:crypto'

import type { MediaSource, MediaTarget } from './types'

export type CopyOutcome = 'already-copied' | 'copied' | 'would-copy'

export type CopyResult = { bytes: number; outcome: CopyOutcome; sha256?: string }

/** The source file does not exist. A failure, not a skip: the record is left without its file. */
export class SourceMissingError extends Error {
  constructor(path: string) {
    super(`Source file not found: ${path}`)
    this.name = 'SourceMissingError'
  }
}

/** SHA-256 of a streamed file, without holding it in memory. */
export const sha256Of = async (body: AsyncIterable<Uint8Array>): Promise<string> => {
  const hash = createHash('sha256')
  for await (const chunk of body) hash.update(chunk)
  return hash.digest('hex')
}

export type CopyOptions = {
  contentType: string
  dryRun?: boolean
  /** Object name in the bucket. */
  key: string
  /** Path inside the uploads directory. */
  path: string
  source: MediaSource
  target: MediaTarget
  /**
   * Re-read the source and compare its checksum with the stored one before trusting an object
   * that is already there. Without it, an existing object of the same size counts as copied.
   */
  verify?: boolean
}

/**
 * Copy one file, resumably. The target is the only state: an object under `key` is complete
 * (stores write nothing until the checksum matches), so a run that was killed picks up by
 * skipping what exists and writing the rest.
 *
 * - Existing object, same size → `already-copied`. A different size means it was written by
 *   something else or from a changed source, so it is replaced.
 * - Otherwise the source is hashed (one pass), then streamed to the target with that checksum
 *   and size, which the target verifies, and the stored object is read back for its size.
 */
export const copyFile = async (options: CopyOptions): Promise<CopyResult> => {
  const { contentType, key, path, source, target } = options
  const info = await source.stat(path)
  if (!info) throw new SourceMissingError(path)

  const existing = await target.head(key)
  if (existing && existing.size === info.size) {
    if (!options.verify) return { bytes: info.size, outcome: 'already-copied', sha256: existing.sha256 }
    const sha256 = await sha256Of(source.read(path))
    if (existing.sha256 === sha256) return { bytes: info.size, outcome: 'already-copied', sha256 }
    // A checksum that differs, or one that was never stored, cannot be trusted: write it again.
  }
  if (options.dryRun) return { bytes: info.size, outcome: 'would-copy' }

  const sha256 = await sha256Of(source.read(path))
  await target.put(key, source.read(path), { contentType, sha256, size: info.size })

  const stored = await target.head(key)
  if (!stored || stored.size !== info.size) {
    await target.delete(key)
    throw new Error(`Verification failed for ${key}: stored ${stored?.size ?? 'nothing'}, expected ${info.size} bytes`)
  }
  return { bytes: info.size, outcome: 'copied', sha256 }
}
