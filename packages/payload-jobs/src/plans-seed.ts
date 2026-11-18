import type { CollectionSlug, Payload, PayloadRequest, Where } from 'payload'

import { ADD_ONS_SLUG } from './add-ons'
import { missingTaxRateKeys } from './catalog'
import {
  planFieldValidators,
  PLAN_JOB_CATEGORIES_SLUG,
  PLAN_JOB_TYPES_SLUG,
  PLAN_KEY_PATTERN,
  PLANS_SLUG,
  validateTaxonomySlugs,
} from './plans'

/** An add-on the plan includes, by the add-on's `key`. Seed the add-ons first. */
export type PlanSeedIncludedAddOn = {
  addOnKey: string
  /** Defaults to the add-on's own duration. `null` = not confirmed yet. */
  durationDays?: null | number
}

/**
 * One plan in a tenant's seed. `null` in `price`, `durationDays` or `jobCredits` marks a value
 * nobody has confirmed yet: the seed refuses to run until every value is known, so a guessed
 * price can never reach a database.
 */
export type PlanSeed = {
  acceptsCredits?: boolean
  /** Slugs of the tenant's job categories; resolved to ids when seeding. Empty: any category. */
  allowedJobCategories?: string[]
  /** Slugs of the tenant's job types; resolved to ids when seeding. Empty: any type. */
  allowedJobTypes?: string[]
  creditExpiryDays?: null | number
  description?: string
  durationDays: null | number
  includedAddOns?: PlanSeedIncludedAddOn[]
  /** Only for voluntary jobs. */
  isVolunteer?: boolean
  jobCredits: null | number
  key: string
  legacyId?: null | number
  name: string
  price: null | number
  sortOrder: number
  taxExempt?: boolean
  /** One of the tenant's tax rate keys; omitted: the default rate. */
  taxRateKey?: null | string
}

const PLAN_SEED_KEYS = new Set<string>([
  'acceptsCredits',
  'allowedJobCategories',
  'allowedJobTypes',
  'creditExpiryDays',
  'description',
  'durationDays',
  'includedAddOns',
  'isVolunteer',
  'jobCredits',
  'key',
  'legacyId',
  'name',
  'price',
  'sortOrder',
  'taxExempt',
  'taxRateKey',
])

/** Values that may be `null` in seed data, meaning "not confirmed yet". */
const UNCONFIRMED_MESSAGES = {
  durationDays: 'duration is not confirmed',
  jobCredits: 'job credits are not confirmed',
  price: 'price is not confirmed',
} as const
const CONFIRMABLE = Object.keys(UNCONFIRMED_MESSAGES) as (keyof typeof UNCONFIRMED_MESSAGES)[]

export type SeedPlansResult = {
  /** Keys of the plans this run created. */
  created: string[]
  /** Keys of the plans that already existed and were left untouched. */
  existing: string[]
}

export class PlanSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlanSeedError'
  }
}

/**
 * Problems with the seed data, one message per problem. Empty when the seed can run.
 *
 * Every field goes through the same validator the plans collection uses on save
 * (`planFieldValidators`), plus the seed's own rules: no unknown fields, no duplicate key or
 * legacyId, and no unconfirmed (`null`) values. So nothing that passes here can fail
 * validation half way through a seed.
 */
export const planSeedProblems = (plans: readonly PlanSeed[]): string[] => {
  const problems: string[] = []
  const keys = new Set<string>()
  const legacyIds = new Set<number>()

  for (const [index, plan] of plans.entries()) {
    if (typeof plan !== 'object' || plan === null) {
      problems.push(`plan ${index + 1}: must be an object`)
      continue
    }

    const label = `"${typeof plan.key === 'string' && plan.key ? plan.key : `plan ${index + 1}`}"`
    const report = (message: string) => problems.push(`${label}: ${message}`)

    for (const field of Object.keys(plan)) {
      if (!PLAN_SEED_KEYS.has(field)) report(`unknown field "${field}"`)
    }

    for (const field of CONFIRMABLE) {
      if (plan[field] === null) report(UNCONFIRMED_MESSAGES[field])
    }

    for (const [field, validate] of Object.entries(planFieldValidators)) {
      const value = (plan as Record<string, unknown>)[field]
      if (value === null && (CONFIRMABLE as readonly string[]).includes(field)) continue
      // sortOrder is required in seeds so plans show in a deliberate order.
      if (field === 'sortOrder' && (value === null || value === undefined)) {
        report('sortOrder is required')
        continue
      }
      const result = (validate as (input: unknown) => string | true)(value)
      if (result !== true) report(result)
    }

    for (const [field, fieldLabel] of [
      ['allowedJobTypes', 'Allowed job types'],
      ['allowedJobCategories', 'Allowed job categories'],
    ] as const) {
      const result = validateTaxonomySlugs(fieldLabel)(plan[field])
      if (result !== true) report(result)
    }

    if (plan.description !== undefined && typeof plan.description !== 'string') {
      report('description must be text')
    }

    if (typeof plan.key === 'string') {
      if (keys.has(plan.key)) report('key is used twice')
      keys.add(plan.key)
    }

    if (plan.legacyId !== null && plan.legacyId !== undefined) {
      if (legacyIds.has(plan.legacyId)) report('legacyId is used twice')
      legacyIds.add(plan.legacyId)
    }

    if (plan.includedAddOns !== undefined && !Array.isArray(plan.includedAddOns)) {
      report('includedAddOns must be a list')
    }
    for (const included of Array.isArray(plan.includedAddOns) ? plan.includedAddOns : []) {
      if (typeof included?.addOnKey !== 'string' || !PLAN_KEY_PATTERN.test(included.addOnKey)) {
        report('included add-on key must be kebab-case')
        continue
      }
      if (included.durationDays === null) {
        report(`duration of "${included.addOnKey}" is not confirmed`)
      } else if (
        included.durationDays !== undefined &&
        (!Number.isSafeInteger(included.durationDays) || included.durationDays < 1)
      ) {
        report(`duration of "${included.addOnKey}" must be 1 day or more`)
      }
    }
  }

  return problems
}

type SeedPlansArgs = {
  payload: Payload
  plans: readonly PlanSeed[]
  /** Pass a request to run inside a caller's transaction. */
  req?: Partial<PayloadRequest>
  tenantID: number | string
}

/**
 * Create a tenant's plans. Idempotent: a plan that already exists in the tenant, matched by
 * `key` or by `legacyId`, is left exactly as it is, so admin edits and imported plans are never
 * overwritten. Running it twice creates nothing the second time.
 *
 * All seed data is checked before anything is written.
 */
export const seedPlans = async ({
  payload,
  plans,
  req,
  tenantID,
}: SeedPlansArgs): Promise<SeedPlansResult> => {
  const problems = planSeedProblems(plans)
  if (problems.length > 0) {
    throw new PlanSeedError(`Plan seed is not ready:\n- ${problems.join('\n- ')}`)
  }

  // Resolve every taxonomy slug before writing, so a missing one can't leave a partial seed.
  const resolve = async (relationTo: string, slugs: readonly string[]) => {
    const wanted = [...new Set(slugs)]
    if (wanted.length === 0) return new Map<string, number | string>()

    const { docs } = await payload.find({
      collection: relationTo as CollectionSlug,
      depth: 0,
      limit: wanted.length,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ tenant: { equals: tenantID } }, { slug: { in: wanted } }] },
    })
    return new Map(docs.map((doc) => [String((doc as { slug?: unknown }).slug), doc.id]))
  }

  const typeIDs = await resolve(
    PLAN_JOB_TYPES_SLUG,
    plans.flatMap((plan) => plan.allowedJobTypes ?? []),
  )
  const categoryIDs = await resolve(
    PLAN_JOB_CATEGORIES_SLUG,
    plans.flatMap((plan) => plan.allowedJobCategories ?? []),
  )
  const missing = plans.flatMap((plan) => [
    ...(plan.allowedJobTypes ?? [])
      .filter((slug) => !typeIDs.has(slug))
      .map((slug) => `"${plan.key}": no job type "${slug}" in this tenant`),
    ...(plan.allowedJobCategories ?? [])
      .filter((slug) => !categoryIDs.has(slug))
      .map((slug) => `"${plan.key}": no job category "${slug}" in this tenant`),
  ])
  if (missing.length > 0) {
    throw new PlanSeedError(`Plan seed is not ready:\n- ${missing.join('\n- ')}`)
  }

  // The included add-ons must already be in the tenant (run `seedAddOns` first).
  const addOnKeys = [
    ...new Set(plans.flatMap((plan) => (plan.includedAddOns ?? []).map((row) => row.addOnKey))),
  ]
  const addOnIDs = new Map<string, number | string>()
  if (addOnKeys.length > 0) {
    const { docs } = await payload.find({
      collection: ADD_ONS_SLUG as CollectionSlug,
      depth: 0,
      limit: addOnKeys.length,
      overrideAccess: true,
      pagination: false,
      req,
      where: { and: [{ tenant: { equals: tenantID } }, { key: { in: addOnKeys } }] },
    })
    for (const doc of docs) addOnIDs.set(String((doc as { key?: unknown }).key), doc.id)
    const unknown = plans.flatMap((plan) =>
      (plan.includedAddOns ?? [])
        .filter((row) => !addOnIDs.has(row.addOnKey))
        .map((row) => `"${plan.key}": no add-on "${row.addOnKey}" in this tenant (seed add-ons first)`),
    )
    if (unknown.length > 0) {
      throw new PlanSeedError(`Plan seed is not ready:\n- ${unknown.join('\n- ')}`)
    }
  }

  const unknownRates = await missingTaxRateKeys({
    keys: plans.flatMap((plan) => (plan.taxRateKey ? [plan.taxRateKey] : [])),
    payload: payload as never,
    req,
    tenantID,
  })
  if (unknownRates.length > 0) {
    throw new PlanSeedError(
      `Plan seed is not ready:\n- ${unknownRates.map((key) => `no tax rate "${key}" on this tenant`).join('\n- ')}`,
    )
  }

  const result: SeedPlansResult = { created: [], existing: [] }

  for (const plan of plans) {
    const match: Where[] = [{ key: { equals: plan.key } }]
    if (plan.legacyId !== null && plan.legacyId !== undefined) {
      match.push({ legacyId: { equals: plan.legacyId } })
    }

    const { totalDocs } = await payload.count({
      collection: PLANS_SLUG,
      overrideAccess: true,
      req,
      where: { and: [{ tenant: { equals: tenantID } }, { or: match }] },
    })

    if (totalDocs > 0) {
      result.existing.push(plan.key)
      continue
    }

    // The seed was checked above, so every value is confirmed. The data is generic here: the
    // host's generated types know the tenant's id type, this package doesn't.
    await payload.create({
      collection: PLANS_SLUG,
      data: {
        acceptsCredits: plan.acceptsCredits ?? true,
        allowedJobCategories: (plan.allowedJobCategories ?? []).map((slug) => categoryIDs.get(slug)),
        allowedJobTypes: (plan.allowedJobTypes ?? []).map((slug) => typeIDs.get(slug)),
        creditExpiryDays: plan.creditExpiryDays ?? null,
        description: plan.description,
        durationDays: plan.durationDays,
        includedAddOns: (plan.includedAddOns ?? []).map((row) => ({
          addOn: addOnIDs.get(row.addOnKey),
          durationDays: row.durationDays ?? null,
        })),
        isVolunteer: plan.isVolunteer ?? false,
        jobCredits: plan.jobCredits,
        key: plan.key,
        legacyId: plan.legacyId ?? null,
        name: plan.name,
        price: plan.price,
        sortOrder: plan.sortOrder,
        status: 'active',
        taxExempt: plan.taxExempt ?? false,
        taxRateKey: plan.taxRateKey ?? null,
        tenant: tenantID,
      } as never,
      overrideAccess: true,
      req,
    })
    result.created.push(plan.key)
  }

  return result
}
