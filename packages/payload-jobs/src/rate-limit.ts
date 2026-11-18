/**
 * Minimal rate limiter contract. It matches the Cloudflare Workers Rate Limiting binding
 * (`env.X.limit({ key })`), so the production binding drops in with no adapter.
 */
export type RateLimiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

export type MemoryRateLimiterOptions = {
  /** Injectable clock for tests. Returns milliseconds. */
  now?: () => number
  /** Requests allowed per key in each window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

/**
 * Fixed-window limiter held in memory. It is per Worker isolate, so it only slows an attacker
 * down: use it in development and tests, and bind the Cloudflare limiter in production.
 */
export const createMemoryRateLimiter = ({
  limit,
  now = Date.now,
  windowMs,
}: MemoryRateLimiterOptions): RateLimiter => {
  const windows = new Map<string, { count: number; resetAt: number }>()

  return {
    limit: async ({ key }) => {
      const time = now()

      // Drop expired windows so a long-lived isolate does not grow without bound.
      if (windows.size > 10_000) {
        for (const [existingKey, window] of windows) {
          if (window.resetAt <= time) windows.delete(existingKey)
        }
      }

      const current = windows.get(key)

      if (!current || current.resetAt <= time) {
        windows.set(key, { count: 1, resetAt: time + windowMs })
        return { success: limit >= 1 }
      }

      current.count += 1

      return { success: current.count <= limit }
    },
  }
}
