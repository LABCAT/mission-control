import { toBase64 } from './bytes'

type Base64Options = {
  alphabet?: 'base64' | 'base64url'
  omitPadding?: boolean
}

type Uint8ArrayWithBase64 = Uint8Array & {
  toBase64?: (options?: Base64Options) => string
}

type Uint8ArrayConstructorWithBase64 = Uint8ArrayConstructor & {
  fromBase64?: (value: string, options?: Base64Options) => Uint8Array
}

const encode = (bytes: Uint8Array, options?: Base64Options): string => {
  let encoded = toBase64(bytes)
  if (options?.alphabet === 'base64url') encoded = encoded.replace(/\+/g, '-').replace(/\//g, '_')
  if (options?.omitPadding) encoded = encoded.replace(/=+$/, '')
  return encoded
}

const decode = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/**
 * worker-mailer 1.3.1 calls `Uint8Array.prototype.toBase64`, which Node 24 lacks (and older
 * workerd may too). Install the guarded polyfill before the library runs. A no-op where the
 * runtime already provides it.
 */
export const ensureBase64Support = (): void => {
  const proto = Uint8Array.prototype as Uint8ArrayWithBase64
  if (typeof proto.toBase64 !== 'function') {
    Object.defineProperty(proto, 'toBase64', {
      configurable: true,
      writable: true,
      value(this: Uint8Array, options?: Base64Options) {
        return encode(this, options)
      },
    })
  }

  const ctor = Uint8Array as Uint8ArrayConstructorWithBase64
  if (typeof ctor.fromBase64 !== 'function') {
    Object.defineProperty(ctor, 'fromBase64', {
      configurable: true,
      writable: true,
      value(value: string) {
        return decode(value)
      },
    })
  }
}
