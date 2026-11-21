import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

import type { MediaSource, MediaTarget, StoredObject } from './types'

/** Resolve `relative` inside `root`, refusing anything that would leave it (`../`, absolute). */
const inside = (root: string, relative: string): string => {
  const resolvedRoot = path.resolve(root)
  const full = path.resolve(resolvedRoot, relative)
  if (full !== resolvedRoot && !full.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes the root: ${relative}`)
  }
  return full
}

/** The legacy uploads directory on disk (a copy of it, never the live server's). */
export const directorySource = (root: string): MediaSource => ({
  async stat(relative) {
    try {
      const info = await stat(inside(root, relative))
      return info.isFile() ? { size: info.size } : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  read: (relative) => createReadStream(inside(root, relative)),
})

/**
 * A local directory standing in for the bucket. Writes go to a temporary file that is renamed
 * once the checksum matches, so an interrupted run never leaves a partial object. The checksum is
 * kept beside the file in `<key>.meta.json`.
 */
export const directoryTarget = (root: string): MediaTarget => {
  const metaPath = (key: string) => `${inside(root, key)}.meta.json`
  return {
    async delete(key) {
      await rm(inside(root, key), { force: true })
      await rm(metaPath(key), { force: true })
    },
    async head(key): Promise<null | StoredObject> {
      try {
        const info = await stat(inside(root, key))
        let sha256: string | undefined
        try {
          sha256 = JSON.parse(await readFile(metaPath(key), 'utf8')).sha256
        } catch {
          // No sidecar: the object exists, but its checksum is unknown.
        }
        return { sha256, size: info.size }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    async put(key, body, meta) {
      const final = inside(root, key)
      const temporary = `${final}.partial`
      await mkdir(path.dirname(final), { recursive: true })
      const hash = createHash('sha256')
      let size = 0
      try {
        async function* counted() {
          for await (const chunk of body) {
            hash.update(chunk)
            size += chunk.byteLength
            yield chunk
          }
        }
        await pipeline(counted, createWriteStream(temporary))
        if (size !== meta.size) throw new Error(`Wrote ${size} bytes, expected ${meta.size}`)
        if (hash.digest('hex') !== meta.sha256) throw new Error('Checksum mismatch after write')
        await writeFile(metaPath(key), JSON.stringify({ sha256: meta.sha256, size }))
        await rename(temporary, final)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
    },
  }
}

/** The part of an R2 bucket binding the copier uses. A real `R2Bucket` satisfies it. */
export type R2BucketLike = {
  delete: (key: string) => Promise<void>
  head: (key: string) => Promise<null | { customMetadata?: Record<string, string>; size: number }>
  put: (
    key: string,
    value: ReadableStream | Uint8Array,
    options?: {
      customMetadata?: Record<string, string>
      httpMetadata?: { contentType?: string }
      sha256?: string
    },
  ) => Promise<unknown>
}

/**
 * Write to R2 through a bucket binding. R2 checks the `sha256` we send against the bytes it
 * receives and rejects the write on a mismatch, so a stored object is always the verified one.
 * R2 needs the length of a streamed body up front: where `FixedLengthStream` exists (workerd) the
 * body is streamed, anywhere else it is buffered (originals are at most a few tens of MB).
 */
export const r2Target = (bucket: R2BucketLike): MediaTarget => ({
  delete: (key) => bucket.delete(key),
  async head(key) {
    const object = await bucket.head(key)
    return object ? { sha256: object.customMetadata?.sha256, size: object.size } : null
  },
  async put(key, body, meta) {
    const FixedLength = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream })
      .FixedLengthStream
    const iterator = body[Symbol.asyncIterator]()
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(next.value)
      },
    })

    let value: ReadableStream | Uint8Array
    if (FixedLength) {
      const fixed = new FixedLength(meta.size)
      void source.pipeTo(fixed.writable)
      value = fixed.readable
    } else {
      value = new Uint8Array(await new Response(source).arrayBuffer())
    }
    await bucket.put(key, value, {
      customMetadata: { sha256: meta.sha256 },
      httpMetadata: { contentType: meta.contentType },
      sha256: meta.sha256,
    })
  },
})
