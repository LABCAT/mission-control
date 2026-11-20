import { ensureBase64Support } from './polyfill'
import type { SmtpConnectionOptions, SmtpEnvelope } from './types'

/**
 * Password transport: worker-mailer over Cloudflare's TCP sockets.
 *
 * Imported lazily so the package can be loaded (and the console transport used) outside
 * Workers, where `cloudflare:sockets` does not exist. Logging is off: the library never
 * needs to know the password, and its error path logs the server's response.
 */
export const sendViaWorkerMailer = async (options: SmtpConnectionOptions, email: SmtpEnvelope): Promise<void> => {
  if (options.credentials.type !== 'password') {
    throw new Error('worker-mailer transport only supports password authentication')
  }
  ensureBase64Support()
  const { WorkerMailer, LogLevel } = await import('worker-mailer')
  const mailer = await WorkerMailer.connect({
    host: options.host,
    port: options.port,
    secure: options.secure,
    startTls: options.startTls,
    credentials: {
      username: options.credentials.username,
      password: options.credentials.password,
    },
    authType: ['plain', 'login', 'cram-md5'],
    logLevel: LogLevel.NONE,
  })
  try {
    await mailer.send(email)
  } finally {
    await mailer.close()
  }
}
