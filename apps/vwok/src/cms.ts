/**
 * This site's CMS client, built once per isolate from the Worker's env.
 *
 * The site key is a secret: it is read here on the server and never reaches a page, so the
 * client is created lazily and cached. `CMS_URL` and `SITE_KEY` are documented in
 * `.dev.vars.example`; a site without them has no CMS and every page that needs one answers 404
 * rather than throwing.
 */
import { createCmsClient, type CmsClient } from '@mission-control/launchpad/cms'

type EnvBag = Record<string, unknown>

const isWorkersRuntime = (): boolean =>
  typeof globalThis.navigator !== 'undefined' && globalThis.navigator?.userAgent === 'Cloudflare-Workers'

/** Workers env (bindings and secrets) when available, else `process.env`. */
const readEnv = async (): Promise<EnvBag> => {
  if (isWorkersRuntime()) {
    // @ts-ignore -- `cloudflare:workers` is typed only where worker-configuration.d.ts is present.
    const { env } = (await import('cloudflare:workers')) as { env: EnvBag }
    return env
  }

  return typeof process !== 'undefined' ? (process.env as EnvBag) : {}
}

let cached: CmsClient | null = null

/** The site's CMS client, or `null` when this deployment has no CMS configured. */
export const cmsClient = async (): Promise<CmsClient | null> => {
  if (cached) return cached

  const env = await readEnv()
  const baseUrl = typeof env.CMS_URL === 'string' ? env.CMS_URL.trim() : ''
  const siteKey = typeof env.SITE_KEY === 'string' ? env.SITE_KEY.trim() : ''
  if (!baseUrl || !siteKey) return null

  cached = createCmsClient({ baseUrl, siteKey })

  return cached
}

/** The CMS origin for the view-beacon proxy, or `null` when none is configured. */
export const cmsOrigin = async (): Promise<null | string> => {
  const env = await readEnv()
  const baseUrl = typeof env.CMS_URL === 'string' ? env.CMS_URL.trim() : ''
  if (!baseUrl) return null

  try {
    return new URL(baseUrl).origin
  } catch {
    return null
  }
}

/** The site key, server-side only. */
export const siteKey = async (): Promise<null | string> => {
  const env = await readEnv()
  const value = typeof env.SITE_KEY === 'string' ? env.SITE_KEY.trim() : ''

  return value || null
}
