/**
 * Recently viewed jobs, kept only in this browser. There is no server store, no account sync
 * and no cookie: a visitor who clears site data gets an empty list, which is the point.
 *
 * The module is deliberately framework-free and runs in any browser. Every storage access is
 * guarded, so private modes and disabled storage simply make the feature do nothing.
 */

/** localStorage key. The value is a JSON array of job ids, newest first. */
export const VIEWED_JOBS_KEY = 'lp:viewed-jobs'

/** Keep a short history: enough to be useful, small enough for a 5 KB storage quota. */
export const VIEWED_JOBS_LIMIT = 20

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    // Some browsers throw on merely touching `localStorage` in private mode.
    return undefined
  }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** Read the stored ids, newest first, ignoring malformed data. Never throws. */
const read = (): string[] => {
  try {
    const raw = storage()?.getItem(VIEWED_JOBS_KEY)
    if (!raw) return []

    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []

    // Dedupe here too: another tab (or an older version) may have written duplicates.
    return [...new Set(parsed.filter(isId))].slice(0, VIEWED_JOBS_LIMIT)
  } catch {
    return []
  }
}

/** Persist the ids. A full or unavailable store is a no-op, never a page error. */
const write = (ids: string[]): void => {
  try {
    storage()?.setItem(VIEWED_JOBS_KEY, JSON.stringify(ids))
  } catch {
    // Quota exceeded, storage disabled, private mode: the feature is optional.
  }
}

/** Record a job as viewed, moving it to the front and keeping the last 20. */
export const record = (jobId: string): void => {
  if (!isId(jobId)) return

  const ids = read().filter((id) => id !== jobId)
  ids.unshift(jobId)
  write(ids.slice(0, VIEWED_JOBS_LIMIT))
}

/** The most recently viewed job ids, newest first. `limit` only narrows the stored list. */
export const list = (limit = VIEWED_JOBS_LIMIT): string[] =>
  limit > 0 ? read().slice(0, limit) : []

/** Whether this browser has recorded the job as viewed. */
export const has = (jobId: string): boolean => isId(jobId) && read().includes(jobId)
