import type { Payload, PayloadRequest, Where } from 'payload'

import { addOnFieldValidators, ADD_ONS_SLUG, type AddOnPlacement } from './add-ons'
import { CATALOG_KEY_PATTERN, missingTaxRateKeys } from './catalog'

/** An add-on this one grants, by the granted add-on's `key`. */
export type AddOnSeedGrant = {
  addOnKey: string
  /** `null` = not confirmed yet. */
  durationDays: null | number
}

/**
 * One add-on in a tenant's seed. `null` in `price` or `durationDays` marks a value nobody has
 * confirmed yet: the seed refuses to run until every value is known.
 */
export type AddOnSeed = {
  active?: boolean
  description?: string
  durationDays: null | number
  grants?: AddOnSeedGrant[]
  key: string
  legacyId?: null | number
  /** The JobRoller job meta key the add-on replaces, e.g. `_jr_featured-listings`. */
  legacyKey?: null | string
  name: string
  placement: AddOnPlacement
  price: null | number
  sortOrder: number
  taxExempt?: boolean
  /** One of the tenant's tax rate keys; omitted: the default rate. */
  taxRateKey?: null | string
}

const ADD_ON_SEED_KEYS = new Set<string>([
  'active',
  'description',
  'durationDays',
  'grants',
  'key',
  'legacyId',
  'legacyKey',
  'name',
  'placement',
  'price',
  'sortOrder',
  'taxExempt',
  'taxRateKey',
])

const UNCONFIRMED_MESSAGES = {
  durationDays: 'duration is not confirmed',
  price: 'price is not confirmed',
} as const
const CONFIRMABLE = Object.keys(UNCONFIRMED_MESSAGES) as (keyof typeof UNCONFIRMED_MESSAGES)[]

export type SeedAddOnsResult = {
  /** Keys of the add-ons this run created. */
  created: string[]
  /** Keys of the add-ons that already existed and were left untouched. */
  existing: string[]
}

export class AddOnSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AddOnSeedError'
  }
}

/**
 * Problems with the seed data, one message per problem; empty when it can run. Each field goes
 * through the collection's own validator, plus: no unknown fields, no duplicate key, legacyId or
 * legacyKey, no unconfirmed values, grants by known kebab-case keys, no self-grant and no cycle
 * among the seeded add-ons. Grant keys not in the seed must already exist in the tenant, which
 * `seedAddOns` checks before writing.
 */
export const addOnSeedProblems = (addOns: readonly AddOnSeed[]): string[] => {
  const problems: string[] = []
  const keys = new Set<string>()
  const legacyIds = new Set<number>()
  const legacyKeys = new Set<string>()

  for (const [index, addOn] of addOns.entries()) {
    if (typeof addOn !== 'object' || addOn === null) {
      problems.push(`add-on ${index + 1}: must be an object`)
      continue
    }

    const label = `"${typeof addOn.key === 'string' && addOn.key ? addOn.key : `add-on ${index + 1}`}"`
    const report = (message: string) => problems.push(`${label}: ${message}`)

    for (const field of Object.keys(addOn)) {
      if (!ADD_ON_SEED_KEYS.has(field)) report(`unknown field "${field}"`)
    }
    for (const field of CONFIRMABLE) {
      if (addOn[field] === null) report(UNCONFIRMED_MESSAGES[field])
    }
    for (const [field, validate] of Object.entries(addOnFieldValidators)) {
      const value = (addOn as Record<string, unknown>)[field]
      if (value === null && (CONFIRMABLE as readonly string[]).includes(field)) continue
      if (field === 'sortOrder' && (value === null || value === undefined)) {
        report('sortOrder is required')
        continue
      }
      const result = (validate as (input: unknown) => string | true)(value)
      if (result !== true) report(result)
    }
    for (const field of ['description', 'legacyKey'] as const) {
      const value = addOn[field]
      if (value !== undefined && value !== null && typeof value !== 'string') report(`${field} must be text`)
    }

    if (typeof addOn.key === 'string') {
      if (keys.has(addOn.key)) report('key is used twice')
      keys.add(addOn.key)
    }
    if (typeof addOn.legacyId === 'number') {
      if (legacyIds.has(addOn.legacyId)) report('legacyId is used twice')
      legacyIds.add(addOn.legacyId)
    }
    if (typeof addOn.legacyKey === 'string') {
      if (legacyKeys.has(addOn.legacyKey)) report('legacyKey is used twice')
      legacyKeys.add(addOn.legacyKey)
    }

    if (addOn.grants !== undefined && !Array.isArray(addOn.grants)) report('grants must be a list')
    const grantKeys = new Set<string>()
    for (const grant of Array.isArray(addOn.grants) ? addOn.grants : []) {
      if (typeof grant?.addOnKey !== 'string' || !CATALOG_KEY_PATTERN.test(grant.addOnKey)) {
        report('granted add-on key must be kebab-case')
        continue
      }
      if (grant.addOnKey === addOn.key) report('an add-on can’t grant itself')
      if (grantKeys.has(grant.addOnKey)) report(`"${grant.addOnKey}" is granted twice`)
      grantKeys.add(grant.addOnKey)
      if (grant.durationDays === null) {
        report(`duration of granted "${grant.addOnKey}" is not confirmed`)
      } else if (!Number.isSafeInteger(grant.durationDays) || grant.durationDays < 1) {
        report(`duration of granted "${grant.addOnKey}" must be 1 day or more`)
      }
    }
  }

  // A cycle among the seeded add-ons can't be created in any order.
  if (problems.length === 0 && seedCreationOrder(addOns) === null) {
    problems.push('the seeded grants form a cycle')
  }

  return problems
}

/**
 * The seed in an order where every add-on comes after the seeded add-ons it grants, or `null`
 * when the grants form a cycle. Grants of add-ons outside the seed don't constrain the order.
 */
const seedCreationOrder = (addOns: readonly AddOnSeed[]): AddOnSeed[] | null => {
  const byKey = new Map(addOns.map((addOn) => [addOn.key, addOn]))
  const ordered: AddOnSeed[] = []
  const state = new Map<string, 'done' | 'visiting'>()

  const visit = (addOn: AddOnSeed): boolean => {
    const mark = state.get(addOn.key)
    if (mark === 'done') return true
    if (mark === 'visiting') return false
    state.set(addOn.key, 'visiting')
    for (const grant of addOn.grants ?? []) {
      const granted = byKey.get(grant.addOnKey)
      if (granted && !visit(granted)) return false
    }
    state.set(addOn.key, 'done')
    ordered.push(addOn)
    return true
  }

  for (const addOn of addOns) if (!visit(addOn)) return null
  return ordered
}

type SeedAddOnsArgs = {
  addOns: readonly AddOnSeed[]
  payload: Payload
  /** Pass a request to run inside a caller's transaction. */
  req?: Partial<PayloadRequest>
  tenantID: number | string
}

/**
 * Create a tenant's add-ons. Idempotent: an add-on that already exists in the tenant, matched by
 * `key`, `legacyId` or `legacyKey`, is left exactly as it is, so admin edits and imports are never
 * overwritten. Everything is checked before anything is written, including that every granted
 * add-on is either in the seed or already in the tenant.
 */
export const seedAddOns = async ({
  addOns,
  payload,
  req,
  tenantID,
}: SeedAddOnsArgs): Promise<SeedAddOnsResult> => {
  const problems = addOnSeedProblems(addOns)
  if (problems.length > 0) {
    throw new AddOnSeedError(`Add-on seed is not ready:\n- ${problems.join('\n- ')}`)
  }

  const findExisting = async (addOn: AddOnSeed) => {
    const match: Where[] = [{ key: { equals: addOn.key } }]
    if (typeof addOn.legacyId === 'number') match.push({ legacyId: { equals: addOn.legacyId } })
    if (typeof addOn.legacyKey === 'string') match.push({ legacyKey: { equals: addOn.legacyKey } })

    const { docs } = await payload.find({
      collection: ADD_ONS_SLUG,
      depth: 0,
      limit: 1,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ tenant: { equals: tenantID } }, { or: match }] },
    })
    return docs[0] as undefined | { id: number | string }
  }

  // Resolve every key a grant names: seeded keys resolve as they are created, the rest must
  // already be in the tenant.
  const seededKeys = new Set(addOns.map((addOn) => addOn.key))
  const outsideKeys = [
    ...new Set(
      addOns.flatMap((addOn) => (addOn.grants ?? []).map((grant) => grant.addOnKey)),
    ),
  ].filter((key) => !seededKeys.has(key))
  const ids = new Map<string, number | string>()

  if (outsideKeys.length > 0) {
    const { docs } = await payload.find({
      collection: ADD_ONS_SLUG,
      depth: 0,
      limit: outsideKeys.length,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ tenant: { equals: tenantID } }, { key: { in: outsideKeys } }] },
    })
    for (const doc of docs) ids.set(String((doc as { key?: unknown }).key), doc.id)
    const missing = outsideKeys.filter((key) => !ids.has(key))
    if (missing.length > 0) {
      throw new AddOnSeedError(
        `Add-on seed is not ready:\n- ${missing.map((key) => `no add-on "${key}" to grant in this tenant`).join('\n- ')}`,
      )
    }
  }

  const unknownRates = await missingTaxRateKeys({
    keys: addOns.flatMap((addOn) => (addOn.taxRateKey ? [addOn.taxRateKey] : [])),
    payload: payload as never,
    req,
    tenantID,
  })
  if (unknownRates.length > 0) {
    throw new AddOnSeedError(
      `Add-on seed is not ready:\n- ${unknownRates.map((key) => `no tax rate "${key}" on this tenant`).join('\n- ')}`,
    )
  }

  const result: SeedAddOnsResult = { created: [], existing: [] }

  for (const addOn of seedCreationOrder(addOns) ?? []) {
    const existing = await findExisting(addOn)
    if (existing) {
      ids.set(addOn.key, existing.id)
      result.existing.push(addOn.key)
      continue
    }

    // Checked above: every value is confirmed and every granted key resolves.
    const created = await payload.create({
      collection: ADD_ONS_SLUG,
      data: {
        active: addOn.active ?? true,
        description: addOn.description,
        durationDays: addOn.durationDays,
        grants: (addOn.grants ?? []).map((grant) => ({
          addOn: ids.get(grant.addOnKey),
          durationDays: grant.durationDays,
        })),
        key: addOn.key,
        legacyId: addOn.legacyId ?? null,
        legacyKey: addOn.legacyKey ?? null,
        name: addOn.name,
        placement: addOn.placement,
        price: addOn.price,
        sortOrder: addOn.sortOrder,
        taxExempt: addOn.taxExempt ?? false,
        taxRateKey: addOn.taxRateKey ?? null,
        tenant: tenantID,
      } as never,
      overrideAccess: true,
      req,
    })
    ids.set(addOn.key, created.id)
    result.created.push(addOn.key)
  }

  // Report in the seed's own order, whatever order they were created in.
  const inSeedOrder = (keys: string[]) => addOns.map((addOn) => addOn.key).filter((key) => keys.includes(key))
  return { created: inSeedOrder(result.created), existing: inSeedOrder(result.existing) }
}
