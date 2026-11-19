import type { SmtpConnectionOptions, SmtpEnvelope } from './types'

/**
 * Default transport: worker-mailer over Cloudflare's TCP sockets.
 *
 * Imported lazily so the package can be loaded (and the console transport used) outside
 * Workers, where `cloudflare:sockets` does not exist. Logging is off: the library never
 * needs to know the password, and its error path logs the server's response.
 */
export const sendViaWorkerMailer = async (options: SmtpConnectionOptions, email: SmtpEnvelope): Promise<void> => {
  const { WorkerMailer, LogLevel } = await import('worker-mailer')
  const mailer = await WorkerMailer.connect({
    host: options.host,
    port: options.port,
    secure: options.secure,
    startTls: options.startTls,
    credentials: options.credentials,
    authType: [...options.authType],
    logLevel: LogLevel.NONE,
  })
  try {
    await mailer.send(email)
  } finally {
    await mailer.close()
  }
}
