import type { Field } from 'payload'

/**
 * A tenant's location tree is generic: levels have no fixed names, so the tenant names them
 * itself. The first label is the top level (`Island` on Vanuatu Wok, `Region` elsewhere), the
 * second its children, and so on. A tenant that names no levels gets generic labels; the tree
 * itself still works.
 */

type Sibling = { siblingData?: Record<string, unknown> }

type StoredLevel = { label?: unknown }

const storedLevels = (value: unknown): StoredLevel[] =>
  Array.isArray(value) ? (value as StoredLevel[]) : []

const trimLabel = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const validateLocationLevels = (value: unknown, { siblingData }: Sibling): string | true => {
  if (siblingData?.isAggregate === true) return true

  const labels = storedLevels(value).map((level) => trimLabel(level?.label))
  if (labels.length === 0) return true
  if (labels.some((label) => label.length === 0)) return 'Each location level needs a label'

  const keys = labels.map((label) => label.toLowerCase())
  if (new Set(keys).size !== keys.length) return 'Each location level label must be different'

  const maxDepth = siblingData?.locationMaxDepth
  if (typeof maxDepth === 'number' && maxDepth >= labels.length) {
    return `The deepest level is ${labels.length - 1} with ${labels.length} levels configured`
  }

  return true
}

const validateLocationMaxDepth = (value: null | number | undefined, { siblingData }: Sibling): string | true => {
  if (siblingData?.isAggregate === true) return true
  if (value === null || value === undefined) return true
  if (!Number.isSafeInteger(value) || value < 0) return 'Use a whole depth of 0 or more'

  const levels = storedLevels(siblingData?.locationLevels).filter(
    (level) => trimLabel(level?.label).length > 0,
  )
  if (levels.length > 0 && value >= levels.length) {
    return `Use a depth from 0 to ${levels.length - 1}, the levels configured above`
  }

  return true
}

/** The location-level fields shared by the tenants collection and the single-tenant global. */
export const tenantLocationFields = (condition?: (data: Record<string, unknown>) => boolean): Field[] => [
  {
    name: 'locationLevels',
    type: 'array',
    admin: {
      ...(condition ? { condition } : {}),
      description:
        'Name the tree’s levels, top first: Island then Town on Vanuatu Wok, or Region, City. They are stored per tenant and read with `locationLevelLabel`; the admin and the public filters do not show them yet.',
    },
    fields: [{ name: 'label', type: 'text', required: true }],
    validate: validateLocationLevels as never,
  },
  {
    name: 'locationMaxDepth',
    type: 'number',
    min: 0,
    admin: {
      ...(condition ? { condition } : {}),
      description:
        'Deepest level allowed, counting the top level as 0. Leave empty for any depth. Vanuatu Wok uses 1: Island then Town.',
      step: 1,
    },
    validate: validateLocationMaxDepth as never,
  },
]

/** The part of a tenant (or settings global) document location settings read. */
export type TenantLocationSource = {
  locationLevels?: null | readonly StoredLevel[]
  locationMaxDepth?: null | number
}

export type TenantLocationSettings = {
  /** Level labels by depth; empty when the tenant has not named them. */
  levels: string[]
  /** Deepest allowed depth, or `null` when the tenant sets no limit. */
  maxDepth: null | number
}

/**
 * A tenant's location settings. Malformed stored values are ignored rather than guessed: a
 * blank or duplicate label is dropped, and a negative max depth means no limit.
 */
export const tenantLocationSettings = (
  source: null | TenantLocationSource | undefined,
): TenantLocationSettings => {
  const levels = storedLevels(source?.locationLevels)
    .map((level) => trimLabel(level?.label))
    .filter((label) => label.length > 0)

  const storedDepth = source?.locationMaxDepth
  const maxDepth =
    typeof storedDepth === 'number' && Number.isSafeInteger(storedDepth) && storedDepth >= 0
      ? storedDepth
      : null

  return { levels, maxDepth }
}

/** The label for one depth, generic when the tenant has not named that level. */
export const locationLevelLabel = (settings: TenantLocationSettings, depth: number): string =>
  settings.levels[depth] ?? `Level ${depth + 1}`
