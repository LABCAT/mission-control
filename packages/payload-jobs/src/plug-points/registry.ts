/**
 * A tiny keyed registry, the building block of every plug point (PJ-115). Registration happens
 * while the Payload config is built, so a duplicate key fails at boot, not at the first request.
 */

export type Keyed = {
  key: string
  /** Lower runs / shows first. Ties keep registration order. Defaults to 100. */
  order?: number
}

/** Keys are lowercase words joined by `-`, `.` or `_`, so they are safe in URLs and settings. */
export const REGISTRY_KEY_PATTERN = /^[a-z][a-z0-9._-]*$/

export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
  }
}

export type Registry<T extends Keyed> = {
  get: (key: string) => T | undefined
  has: (key: string) => boolean
  /** Definitions ordered by `order`, then by registration. */
  list: () => T[]
  /** Throws on an invalid or duplicate key. Returns the definition for chaining. */
  register: (definition: T) => T
}

export const DEFAULT_ORDER = 100

export const createRegistry = <T extends Keyed>(name: string): Registry<T> => {
  const entries = new Map<string, T>()

  return {
    get: (key) => entries.get(key),
    has: (key) => entries.has(key),
    list: () =>
      [...entries.values()]
        .map((entry, index) => ({ entry, index }))
        .sort(
          (a, b) =>
            (a.entry.order ?? DEFAULT_ORDER) - (b.entry.order ?? DEFAULT_ORDER) || a.index - b.index,
        )
        .map(({ entry }) => entry),
    register: (definition) => {
      if (!REGISTRY_KEY_PATTERN.test(definition.key)) {
        throw new RegistryError(
          `payload-jobs: ${name} key "${definition.key}" is invalid. Use lowercase letters, digits, ".", "-" or "_", starting with a letter.`,
        )
      }
      if (entries.has(definition.key)) {
        throw new RegistryError(`payload-jobs: ${name} "${definition.key}" is already registered.`)
      }
      entries.set(definition.key, definition)

      return definition
    },
  }
}
