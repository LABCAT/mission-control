import { createHash } from 'node:crypto'

import type { MediaSource, MediaTarget, StoredObject } from './types'

type Row = Record<string, unknown>

const bytes = (text: string) => new TextEncoder().encode(text)

/** A fake uploads directory: path → bytes. `reads` counts how often each path was streamed. */
export const fakeSource = (files: Record<string, string>) => {
  const reads: Record<string, number> = {}
  const source: MediaSource = {
    async stat(path) {
      return path in files ? { size: bytes(files[path]!).byteLength } : null
    },
    read(path) {
      reads[path] = (reads[path] ?? 0) + 1
      const data = bytes(files[path]!)
      // Two chunks, so the copier really streams.
      const half = Math.ceil(data.byteLength / 2)
      return (async function* () {
        yield data.slice(0, half)
        yield data.slice(half)
      })()
    },
  }
  return { files, reads, source }
}

/**
 * A fake bucket that behaves like R2: it verifies the checksum and size it is given and writes
 * nothing under the key unless both match. `failNext` makes the next put die half way.
 */
export const fakeBucket = () => {
  const objects = new Map<string, StoredObject & { contentType: string; data: Uint8Array }>()
  const state = { failNext: false, puts: [] as string[] }
  const target: MediaTarget = {
    async delete(key) {
      objects.delete(key)
    },
    async head(key) {
      const object = objects.get(key)
      return object ? { sha256: object.sha256, size: object.size } : null
    },
    async put(key, body, meta) {
      const chunks: Uint8Array[] = []
      for await (const chunk of body) {
        chunks.push(chunk)
        if (state.failNext) {
          state.failNext = false
          throw new Error('connection reset')
        }
      }
      const data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let at = 0
      for (const chunk of chunks) {
        data.set(chunk, at)
        at += chunk.byteLength
      }
      if (data.byteLength !== meta.size) throw new Error('size mismatch')
      if (createHash('sha256').update(data).digest('hex') !== meta.sha256) throw new Error('checksum mismatch')
      state.puts.push(key)
      objects.set(key, { contentType: meta.contentType, data, sha256: meta.sha256, size: data.byteLength })
    },
  }
  return { objects, state, target }
}

let metaId = 0
const meta = (table: 'post' | 'user', id: number, key: string, value: string): Row =>
  table === 'post'
    ? { meta_id: ++metaId, meta_key: key, meta_value: value, post_id: id }
    : { meta_id: ++metaId, meta_key: key, meta_value: value, umeta_id: metaId, user_id: id }

const attachment = (ID: number, path: string, mime: string, parent = 0, title = `File ${ID}`): [Row, Row] => [
  { ID, post_mime_type: mime, post_parent: parent, post_status: 'inherit', post_title: title, post_type: 'attachment' },
  meta('post', ID, '_wp_attached_file', path),
]

const caps = (role: string) => `a:1:{s:${role.length}:"${role}";b:1;}`

/**
 * Made-up legacy data for the media import. Users 2 and 3 are one organisation (same nickname);
 * 6 has a logo given as a URL of a generated thumbnail; 8 points at `uploaded_cvs`.
 */
const attachments = [
  attachment(501, '2020/05/logo-resort.png', 'image/png', 0, 'Resort logo'),
  attachment(502, 'company_logos/charters.jpg', 'image/jpeg'),
  attachment(503, '2022/03/front-desk.pdf', 'application/pdf', 101, 'Front desk description'),
  attachment(504, '2022/04/skipper-old.pdf', 'application/pdf', 102),
  attachment(505, '2023/01/skipper.pdf', 'application/pdf', 102),
  attachment(506, '2024/02/about-hero.jpg', 'image/jpeg', 201),
  attachment(507, 'uploaded_cvs/someone.pdf', 'application/pdf', 101),
  attachment(508, '2025/06/huge.pdf', 'application/pdf', 103),
  attachment(509, '2021/01/share.png', 'image/png', 0),
  attachment(510, '2019/09/missing.png', 'image/png'),
  attachment(511, '2022/05/job-logo.png', 'image/png', 101),
].flat()

export const mediaTables: Record<string, Row[]> = {
  wp_users: [
    { ID: 2, display_name: 'Pat', user_email: 'pat@example.com', user_pass: 'x', user_url: '' },
    { ID: 3, display_name: 'Sam', user_email: 'sam@example.com', user_pass: 'x', user_url: '' },
    { ID: 6, display_name: 'Charter', user_email: 'charter@example.com', user_pass: 'x', user_url: '' },
    { ID: 8, display_name: 'Cv Co', user_email: 'cv@example.com', user_pass: 'x', user_url: '' },
    { ID: 9, display_name: 'No Logo', user_email: 'nologo@example.com', user_pass: 'x', user_url: '' },
  ],
  wp_usermeta: [
    ...[2, 3, 6, 8, 9].map((id) => meta('user', id, 'wp_capabilities', caps('job_lister'))),
    ...[2, 3, 6, 8, 9].map((id) => meta('user', id, 'last_login', '2026-03-01 00:00:00')),
    meta('user', 2, 'nickname', 'Example Resort'),
    meta('user', 3, 'nickname', 'Example Resort'),
    meta('user', 6, 'nickname', 'Sample Charters'),
    meta('user', 8, 'nickname', 'Cv Co'),
    meta('user', 9, 'nickname', 'No Logo Co'),
    // The owner (2) has no logo; the second member (3) does: it still counts.
    meta('user', 3, 'company-logo', '501'),
    meta('user', 6, 'company-logo', 'https://vanuatuwok.vu/app/uploads/company_logos/charters-150x150.jpg'),
    meta('user', 8, 'company-logo', 'https://vanuatuwok.vu/app/uploads/uploaded_cvs/me.png'),
    meta('user', 9, 'delete-logo', '1'),
  ],
  wp_posts: [
    { ID: 101, post_type: 'job_listing', post_status: 'publish', post_author: 2, post_date: '2025-03-01 09:00:00' },
    { ID: 102, post_type: 'job_listing', post_status: 'expired', post_author: 6, post_date: '2024-11-12 10:30:00' },
    { ID: 103, post_type: 'job_listing', post_status: 'publish', post_author: 2, post_date: '2025-06-01 10:30:00' },
    { ID: 201, post_type: 'page', post_status: 'publish', post_author: 1, post_date: '2023-01-05 00:00:00' },
    { ID: 202, post_type: 'page', post_status: 'publish', post_author: 1, post_date: '2023-01-06 00:00:00' },
    { ID: 203, post_type: 'page', post_status: 'publish', post_author: 1, post_date: '2023-01-07 00:00:00' },
    ...attachments.filter((row) => 'post_type' in row),
  ],
  wp_postmeta: [
    ...attachments.filter((row) => 'post_id' in row),
    meta('post', 201, '_thumbnail_id', '506'),
    // No featured image: Yoast's share image is used.
    meta('post', 202, '_yoast_wpseo_opengraph-image-id', '509'),
    // A featured image whose attachment is gone.
    meta('post', 203, '_thumbnail_id', '999'),
    // A job's featured image is its logo; the job has no logo field, so it is not imported.
    meta('post', 101, '_thumbnail_id', '511'),
  ],
}

export const mediaFiles: Record<string, string> = {
  '2020/05/logo-resort.png': 'PNG-resort',
  'company_logos/charters.jpg': 'JPG-charters',
  '2022/03/front-desk.pdf': 'PDF-front-desk',
  '2023/01/skipper.pdf': 'PDF-skipper',
  '2024/02/about-hero.jpg': 'JPG-hero',
  '2021/01/share.png': 'PNG-share',
  '2025/06/huge.pdf': 'PDF-huge-0123456789',
  '2022/04/skipper-old.pdf': 'PDF-old',
  'uploaded_cvs/someone.pdf': 'PERSONAL',
  'uploaded_cvs/me.png': 'PERSONAL',
  '2022/05/job-logo.png': 'PNG-job-logo',
  // A generated thumbnail that must never be copied.
  'company_logos/charters-150x150.jpg': 'THUMB',
}
