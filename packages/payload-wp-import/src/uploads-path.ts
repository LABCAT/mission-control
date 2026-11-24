/**
 * A path inside uploads from what a meta value holds: a URL (`https://x/app/uploads/2020/a.png`)
 * or a relative path. Returns `null` for anything that is not under an `uploads` folder, so a
 * file hosted elsewhere is not guessed at.
 *
 * Shared by the media plan (PJ-63) and the site-settings import (PJ-67), which records the
 * banner and logo paths before the media import copies them.
 */
export const uploadsPathOf = (value: string): null | string => {
  const text = value.trim()
  if (!text) return null
  const marker = /\/uploads\/(.+)$/i.exec(text.split(/[?#]/)[0]!)
  const relative = marker ? marker[1]! : /^[a-z][a-z0-9+.-]*:/i.test(text) ? null : text
  if (!relative) return null
  const parts = relative.replaceAll('\\', '/').split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.')) return null
  try {
    return parts.map((part) => decodeURIComponent(part)).join('/')
  } catch {
    return null
  }
}
