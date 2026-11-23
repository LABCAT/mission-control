/**
 * Finding the content-version store among a Worker's bindings (PJ-41).
 *
 * The store is a Cloudflare KV namespace bound as `CONTENT_CACHE`. A deployment that has not
 * provisioned the namespace yet (a preview, `astro dev`, the Node CLI) simply has no binding, and
 * everything downstream falls back to the default version. The check is structural rather than an
 * `instanceof`, because the binding crosses an isolate boundary and the type is ambient.
 */
import type { ContentVersionStore } from '@mission-control/content-cache'

/** The bindings this helper looks for. Both apps' `Env` satisfies it. */
export type ContentCacheEnv = { CONTENT_CACHE?: unknown }

const isStore = (value: unknown): value is ContentVersionStore =>
  typeof (value as ContentVersionStore | null)?.get === 'function' &&
  typeof (value as ContentVersionStore | null)?.put === 'function'

/**
 * The KV namespace that holds the tenant content versions, or `undefined` when this deployment has
 * none. Read it inside a request: workerd forbids touching a binding at module scope.
 */
export const contentVersionStore = (
  env: ContentCacheEnv | null | undefined,
): ContentVersionStore | undefined => {
  const binding = env?.CONTENT_CACHE

  return isStore(binding) ? binding : undefined
}
