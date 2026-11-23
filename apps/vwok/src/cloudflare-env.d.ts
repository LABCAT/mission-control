// The Worker's bindings, as far as this app reads them. Secrets and vars arrive through
// `cloudflare:workers` (not request-scoped), so a view-as endpoint can read them directly.
declare module 'cloudflare:workers' {
  export const env: { CMS_URL?: string; SITE_KEY?: string }
}
