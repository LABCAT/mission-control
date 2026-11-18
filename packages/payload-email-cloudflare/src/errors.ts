/**
 * Thrown for every send failure. Messages carry the provider and, for HTTP providers, the
 * status and the provider's error message. They never include the API key, recipients,
 * subject or body.
 */
export class EmailSendError extends Error {
  readonly provider: 'cloudflare' | 'resend' | 'adapter'
  readonly status?: number

  constructor(provider: 'cloudflare' | 'resend' | 'adapter', message: string, status?: number) {
    super(`[payload-email-cloudflare] ${provider}: ${message}`)
    this.name = 'EmailSendError'
    this.provider = provider
    if (status !== undefined) this.status = status
  }
}

/** Remove every occurrence of the given secrets from a string. */
export const redact = (text: string, secrets: readonly (string | undefined)[]): string =>
  secrets.reduce<string>(
    (acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc),
    text,
  )
