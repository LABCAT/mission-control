/**
 * The values this Worker reads from its environment.
 *
 * They arrive through `cloudflare:workers`, which only exists inside the runtime: the dynamic
 * import keeps `astro check` and the tests, which run in Node, working. Nothing here is a
 * secret in the browser sense, but `SITE_KEY` must never be sent to a page.
 */

export type SiteEnv = {
  /** PJ-104 takes this over as a per-tenant setting; until then it is a deployment switch. */
  AI_CRAWLERS_ALLOWED?: string
  CMS_URL?: string
  /** The public Turnstile site key for the alert forms (PJ-47). */
  PUBLIC_TURNSTILE_SITE_KEY?: string
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
