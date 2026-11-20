/**
 * Thrown for every send failure. Messages carry the provider and the SMTP server's
 * response text. They never include the password, recipients, subject or body.
 */
export class EmailSendError extends Error {
  readonly provider: 'smtp' | 'adapter'

  constructor(provider: 'smtp' | 'adapter', message: string) {
    super(`[payload-email-smtp] ${provider}: ${message}`)
    this.name = 'EmailSendError'
    this.provider = provider
  }
}

/** Remove every occurrence of the given secrets from a string. */
export const redact = (text: string, secrets: readonly (string | undefined)[]): string =>
  secrets.reduce<string>(
    (acc, secret) => (secret ? acc.split(secret).join('[redacted]') : acc),
    text,
  )
