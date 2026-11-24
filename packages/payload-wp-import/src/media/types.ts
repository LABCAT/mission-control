/** What a legacy file is used for. Decides the target collection and the relation that is set. */
export type MediaKind =
  | 'banner-desktop'
  | 'banner-mobile'
  | 'cover'
  | 'job-pdf'
  | 'logo'
  | 'page-image'

/** The imported record that owns a file. Looked up by `legacyId` and tenant. */
export type MediaOwner = {
  collection: 'jobs' | 'organisations' | 'pages' | 'site-settings'
  /**
   * WordPress id: the owner user's id for an organisation, the post id for a job or page, and
   * the fixed `SITE_SETTINGS_LEGACY_ID` for a site's settings.
   */
  legacyId: number
}

/** One file an imported record points at, before it is copied. */
export type MediaRef = {
  /** WordPress attachment id, when the file is an attachment. */
  attachmentId?: number
  kind: MediaKind
  owner: MediaOwner
  /** Path inside the uploads directory, with forward slashes: `2022/03/job.pdf`. */
  path: string
  /** Attachment title, used as the alt text or document title. */
  title?: string
}

/** Read access to the legacy `wp-content/uploads` directory. */
export type MediaSource = {
  /** Size in bytes, or `null` when the file does not exist. */
  stat: (path: string) => Promise<null | { size: number }>
  /** The file's bytes, streamed. */
  read: (path: string) => AsyncIterable<Uint8Array>
}

export type StoredObject = {
  /** Lower-case hex SHA-256 recorded when the object was written, if the store keeps it. */
  sha256?: string
  size: number
}

/** The bucket (R2, or a local directory for dry local runs). Keys are flat file names. */
export type MediaTarget = {
  delete: (key: string) => Promise<void>
  head: (key: string) => Promise<null | StoredObject>
  /**
   * Write an object. The store must verify `sha256` and `size` against the bytes it received and
   * throw, leaving nothing behind, on a mismatch. Nothing may appear under `key` until complete.
   */
  put: (
    key: string,
    body: AsyncIterable<Uint8Array>,
    meta: { contentType: string; sha256: string; size: number },
  ) => Promise<void>
}
