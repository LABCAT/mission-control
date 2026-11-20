/**
 * Analytics failures. Messages are fixed strings: they never include the API token, the
 * request URL, the GraphQL body, or Cloudflare's own error text.
 */
export class AnalyticsError extends Error {
  readonly kind: 'config' | 'request'

  constructor(kind: 'config' | 'request', message: string) {
    super(`[payload-cloudflare-analytics] ${message}`)
    this.name = 'AnalyticsError'
    this.kind = kind
  }
}
