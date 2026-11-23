import type { RedirectConfig } from '@mission-control/payload-email-cloudflare'

type EmailEnv = { ENVIRONMENT?: string; EMAIL_REDIRECT_TO?: string }

/**
 * mission-control: email safety (PJ-94). Redirect is ON unless the environment is explicitly
 * `production`. Falls back to `process.env` outside Workers (Node CLI, tests, `pnpm dev`).
 */
export const emailRedirect = (workerEnv?: EmailEnv): RedirectConfig | undefined => {
  const proc = typeof process !== 'undefined' ? process.env : {}
  const environment = (workerEnv?.ENVIRONMENT ?? proc.ENVIRONMENT)?.trim().toLowerCase()
  if (environment === 'production') return undefined
  return { to: workerEnv?.EMAIL_REDIRECT_TO ?? proc.EMAIL_REDIRECT_TO, label: environment || 'non-production' }
}
