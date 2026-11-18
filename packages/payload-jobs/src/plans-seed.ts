import type { Payload, PayloadRequest, Where } from 'payload'

import { isMinorUnits } from './money'
import { PLAN_KEY_PATTERN, PLANS_SLUG } from './plans'

/**
 * One plan in a tenant's seed. `null` marks a value nobody has confirmed yet: the seed refuses
 * to run until every value is known, so a guessed price can never reach a database.
 */
export type PlanSeed = {
  acceptsCredits?: boolean
  creditExpiryDays?: null | number
  description?: string
  durationDays: null | number
  jobCredits: null | number
  key: string
  legacyId?: null | number
  name: string
  price: null | number
  sortOrder: number
}

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

/** Problems with the seed data, one message per problem. Empty when the seed can run. */
export const planSeedProblems = (plans: readonly PlanSeed[]): string[] => {
  const problems: string[] = []
  const keys = new Set<string>()
  const legacyIds = new Set<number>()

  for (const plan of plans) {
    const label = `"${plan.key || plan.name}"`

    if (!PLAN_KEY_PATTERN.test(plan.key)) problems.push(`${label}: key must be kebab-case`)
    if (keys.has(plan.key)) problems.push(`${label}: key is used twice`)
    keys.add(plan.key)

    if (plan.legacyId !== null && plan.legacyId !== undefined) {
      if (legacyIds.has(plan.legacyId)) problems.push(`${label}: legacyId is used twice`)
      legacyIds.add(plan.legacyId)
    }

    if (!plan.name.trim()) problems.push(`${label}: name is required`)
    if (plan.price === null) problems.push(`${label}: price is not confirmed`)
    else if (!isMinorUnits(plan.price)) problems.push(`${label}: price must be whole minor units`)
    if (plan.durationDays === null) problems.push(`${label}: duration is not confirmed`)
    else if (!Number.isSafeInteger(plan.durationDays) || plan.durationDays < 1) {
      problems.push(`${label}: duration must be 1 day or more`)
    }
    if (plan.jobCredits === null) problems.push(`${label}: job credits are not confirmed`)
    else if (!Number.isSafeInteger(plan.jobCredits) || plan.jobCredits < 1) {
      problems.push(`${label}: job credits must be 1 or more`)
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
        creditExpiryDays: plan.creditExpiryDays ?? null,
        description: plan.description,
        durationDays: plan.durationDays,
        jobCredits: plan.jobCredits,
        key: plan.key,
        legacyId: plan.legacyId ?? null,
        name: plan.name,
        price: plan.price,
        sortOrder: plan.sortOrder,
        status: 'active',
        tenant: tenantID,
      } as never,
      overrideAccess: true,
      req,
    })
    result.created.push(plan.key)
  }

  return result
}
