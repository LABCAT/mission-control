export type AnalyticsCache<T> = {
  clear: () => void
  get: (key: string) => T | undefined
  set: (key: string, value: T, ttlMs: number) => void
}

type Entry<T> = {
  expiresAt: number
  value: T
}

/**
 * Small in-memory TTL cache for a Worker isolate. Values are dropped lazily when read,
 * so there is no timer holding the isolate open.
 */
export const createMemoryCache = <T>(
  now: () => number = Date.now,
): AnalyticsCache<T> => {
  const entries = new Map<string, Entry<T>>()

  return {
    clear: () => {
      entries.clear()
    },
    get: (key) => {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= now()) {
        entries.delete(key)
        return undefined
      }
      return entry.value
    },
    set: (key, value, ttlMs) => {
      if (ttlMs <= 0) return
      entries.set(key, { expiresAt: now() + ttlMs, value })
    },
  }
}
