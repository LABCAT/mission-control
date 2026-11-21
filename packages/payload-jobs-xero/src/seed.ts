import type { CollectionSlug, Payload } from 'payload'

import { DEFAULT_SETTINGS_SLUG } from '@mission-control/payload-xero'

/**
 * A tenant's Xero settings as seeded (PJ-57). Only what the old site had; the organisation ID,
 * tokens and branding theme come from connecting Xero (PJ-59).
 */
export type XeroSettingsSeed = {
  accountCodes: { addOn: null | string; discount: null | string; plan: null | string }
  /** Authorise invoices when the order is confirmed (`false`: keep them as drafts). */
  authorise: boolean
  dueDays: number
  /** Bank account to record payments against; `null`: payments are not recorded in Xero. */
  reconciliationAccountCode: null | string
  trackingCategory: null | { name: string; option: string }
}

export const xeroSettingsSeedProblems = (seed: XeroSettingsSeed): string[] => {
  const problems: string[] = []
  for (const [key, value] of Object.entries(seed.accountCodes)) {
    if (value !== null && !/^[A-Za-z0-9._-]{1,10}$/.test(value)) problems.push(`accountCodes.${key} is not a Xero account code`)
  }
  if (!Number.isInteger(seed.dueDays) || seed.dueDays < 0 || seed.dueDays > 365) problems.push('dueDays must be 0 to 365')
  if (seed.trackingCategory && (!seed.trackingCategory.name.trim() || !seed.trackingCategory.option.trim())) {
    problems.push('trackingCategory needs a name and an option')
  }
  return problems
}

/**
 * Create the tenant's Xero settings row from the seed. Idempotent: a tenant that already has a
 * row (seeded, or created by connecting Xero) keeps it unchanged.
 */
export const seedXeroSettings = async ({
  payload,
  seed,
  settingsSlug = DEFAULT_SETTINGS_SLUG,
  tenantField = 'tenant',
  tenantID,
}: {
  payload: Payload
  seed: XeroSettingsSeed
  settingsSlug?: string
  tenantField?: string
  tenantID: number | string
}): Promise<{ applied: boolean }> => {
  const problems = xeroSettingsSeedProblems(seed)
  if (problems.length > 0) throw new Error(`Xero settings seed: ${problems.join('; ')}`)

  const { totalDocs } = await payload.count({
    collection: settingsSlug as CollectionSlug,
    overrideAccess: true,
    where: { [tenantField]: { equals: tenantID } },
  })
  if (totalDocs > 0) return { applied: false }

  await payload.create({
    collection: settingsSlug as CollectionSlug,
    data: {
      accountCodes: seed.accountCodes,
      dueDays: seed.dueDays,
      invoicing: { authorise: seed.authorise },
      reconciliationAccountCode: seed.reconciliationAccountCode,
      [tenantField]: tenantID,
      trackingCategory: seed.trackingCategory ?? { name: null, option: null },
    } as never,
    overrideAccess: true,
  })

  return { applied: true }
}
