// @ts-ignore -- `cloudflare:sockets` is typed only where Workers types are present.
import { connect as workersConnect } from 'cloudflare:sockets'

export type SocketLike = {
  opened: Promise<unknown>
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close(): Promise<void>
  startTls(): SocketLike
}

export type ConnectLike = (
  address: { hostname: string; port: number },
  init: { secureTransport: 'on' | 'starttls' | 'off'; allowHalfOpen: boolean },
) => SocketLike

/** Static import so Workers bundlers keep the runtime built-in; tests mock this module. */
export const connect = workersConnect as ConnectLike
