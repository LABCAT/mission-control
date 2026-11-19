'use strict'

/**
 * Test-only stand-in for `cloudflare:sockets`' `connect`.
 *
 * The real worker-mailer talks SMTP to this in-memory server, so the tests exercise the
 * actual header/attachment encoding and the STARTTLS / implicit-TLS paths. Tests configure
 * it through `globalThis.smtpTestServer`; per-connection state (buffers, TLS flag) lives here.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** @returns {object} a fake socket speaking just enough SMTP for worker-mailer */
const createConnection = (server) => {
  let controller
  const readable = new ReadableStream({
    start(c) {
      controller = c
    },
  })
  const send = (text) => controller.enqueue(encoder.encode(text))
  const reply = (line) => send(`${line}\r\n`)

  let buffer = ''
  let dataMode = false
  let data = ''
  let tls = false
  let closed = false

  /** @param {string} line one SMTP command line, without CRLF */
  const handleCommand = (line) => {
    server.commands.push(line)
    const upper = line.toUpperCase()
    if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
      reply('250-fake.test')
      if (!tls) reply('250-STARTTLS')
      reply('250-AUTH PLAIN LOGIN')
      reply('250 OK')
    } else if (upper === 'STARTTLS') {
      tls = true
      reply('220 2.0.0 Ready to start TLS')
    } else if (upper.startsWith('AUTH PLAIN')) {
      const encoded = line.slice('AUTH PLAIN'.length).trim()
      const password = Buffer.from(encoded, 'base64').toString('utf8').split('\0').pop()
      if (password === server.password) {
        reply('235 2.7.0 Authentication successful')
      } else {
        // Deliberately echo the credential to prove the client redacts it.
        reply(`535 5.7.8 Username and Password not accepted: ${password}`)
      }
    } else if (upper.startsWith('AUTH LOGIN')) {
      reply('535 5.7.8 Use AUTH PLAIN')
    } else if (upper.startsWith('MAIL FROM')) {
      reply('250 2.1.0 OK')
    } else if (upper.startsWith('RCPT TO')) {
      server.recipients.push(line)
      reply('250 2.1.5 OK')
    } else if (upper === 'DATA') {
      dataMode = true
      reply('354 End data with <CR><LF>.<CR><LF>')
    } else if (upper === 'RSET') {
      reply('250 2.0.0 OK')
    } else if (upper === 'QUIT') {
      reply('221 2.0.0 Bye')
      closed = true
      controller.close()
    } else {
      reply('250 2.0.0 OK')
    }
  }

  const writable = new WritableStream({
    write(chunk) {
      if (closed) return
      buffer += decoder.decode(chunk, { stream: true })
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end === -1) return
        data += buffer.slice(0, end)
        buffer = buffer.slice(end + 5)
        dataMode = false
        server.lastMessage = data
        server.messageIds.push(data)
        data = ''
        reply(`250 2.0.0 Ok: queued as ${server.queueId}`)
        return
      }
      let index
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handleCommand(line)
      }
    },
    close() {
      if (!closed) controller.close()
    },
  })

  const socket = {
    opened: Promise.resolve(),
    readable,
    writable,
    close() {
      if (!closed) {
        closed = true
        controller.close()
      }
      return Promise.resolve()
    },
    startTls() {
      // Same streams; the SMTP session continues with no new greeting.
      return socket
    },
  }

  send('220 fake.test ESMTP ready\r\n')
  return socket
}

module.exports = {
  connect() {
    const server = globalThis.smtpTestServer
    if (server.refuse) {
      return {
        opened: Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:587')),
        readable: new ReadableStream(),
        writable: new WritableStream(),
        close: () => Promise.resolve(),
        startTls() {
          throw new Error('no tls')
        },
      }
    }
    return createConnection(server)
  },
}
