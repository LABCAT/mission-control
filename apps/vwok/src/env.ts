/**
 * The values this Worker reads from its environment.
 *
 * They arrive through `cloudflare:workers`, which only exists inside the runtime: the dynamic
 * import keeps `astro check` and the tests, which run in Node, working. Nothing here is a
 * secret in the browser sense, but `SITE_KEY` must never be sent to a page.
 */

/** The part of an R2 bucket the share-image store uses; a real `R2Bucket` satisfies it. */
type OgBucket = {
  get(key: string): Promise<null | { arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string, string> }>
  put(key: string, value: ArrayBuffer, options?: unknown): Promise<unknown>
}

export type SiteEnv = {
  /** PJ-104 takes this over as a per-tenant setting; until then it is a deployment switch. */
  AI_CRAWLERS_ALLOWED?: string
  CMS_URL?: string
  /**
   * Share images (PJ-105). Optional: without the binding an image is still generated and
   * edge-cached, it is just not kept in R2 between isolates.
   */
  OG_IMAGES?: OgBucket
  SITE_KEY?: string
}

export const siteEnv = async (): Promise<SiteEnv> => {
  try {
    // @ts-ignore -- `cloudflare:workers` is typed only where worker-configuration.d.ts exists.
    const { env } = (await import('cloudflare:workers')) as { env?: SiteEnv }
    return env ?? {}
  } catch {
    return {}
  }
}

/**
 * AI crawlers may read the site unless the deployment turns them away. `false` or `0` blocks
 * them; anything else, including unset, allows them, which is vwok's legacy behaviour.
 */
export const aiCrawlersAllowed = (env: SiteEnv): boolean => {
  const value = env.AI_CRAWLERS_ALLOWED?.trim().toLowerCase()
  return value !== 'false' && value !== '0'
}
